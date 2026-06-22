import * as Y from "yjs";
import { clampRange, computeRemoteCarets } from "./remote-cursors";

function relCursor(ytext: Y.Text, anchorIdx: number, headIdx: number) {
	return {
		anchor: Y.createRelativePositionFromTypeIndex(ytext, anchorIdx),
		head: Y.createRelativePositionFromTypeIndex(ytext, headIdx),
	};
}

describe("clampRange", () => {
	test("clamps both ends into [0, docLen] and normalizes order", () => {
		expect(clampRange(80, 95, 5)).toEqual({ from: 5, to: 5 });
		expect(clampRange(-3, 2, 10)).toEqual({ from: 0, to: 2 });
		expect(clampRange(7, 3, 10)).toEqual({ from: 3, to: 7 });
	});
});

describe("computeRemoteCarets", () => {
	// The exact bug that removed the feature: a remote cursor index resolved
	// against the shared ydoc exceeds the *local* editor doc length while the
	// editor lags (Korean IME composition). The old yRemoteSelections called
	// lineAt(index) unclamped → RangeError → plugin death.
	test("REGRESSION: remote index beyond local docLength does not throw and clamps", () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText("content");
		ytext.insert(0, "x".repeat(100)); // server ahead: ytext length 100
		const states = new Map<number, unknown>([
			[2, { cursor: relCursor(ytext, 80, 80), user: { name: "Bob", color: "#f00" } }],
		]);

		const localDocLength = 5; // editor lags ytext (IME window)
		let carets: ReturnType<typeof computeRemoteCarets> = [];
		expect(() => {
			carets = computeRemoteCarets(localDocLength, states, ytext, ydoc, 1);
		}).not.toThrow();

		expect(carets).toHaveLength(1);
		expect(carets[0].head).toBeLessThanOrEqual(localDocLength);
		expect(carets[0].from).toBeLessThanOrEqual(localDocLength);
		expect(carets[0].to).toBeLessThanOrEqual(localDocLength);
		expect(carets[0].name).toBe("Bob");
	});

	test("in-range selection yields correct from/to/head", () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText("content");
		ytext.insert(0, "hello world"); // length 11
		const states = new Map<number, unknown>([
			[2, { cursor: relCursor(ytext, 2, 7), user: { name: "Bob", color: "#f00" } }],
		]);

		const carets = computeRemoteCarets(11, states, ytext, ydoc, 1);
		expect(carets).toHaveLength(1);
		expect(carets[0]).toMatchObject({ from: 2, to: 7, head: 7, name: "Bob" });
	});

	test("skips local client and states without a cursor", () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText("content");
		ytext.insert(0, "abc");
		const cursor = relCursor(ytext, 1, 1);
		const states = new Map<number, unknown>([
			[1, { cursor, user: { name: "Me" } }], // local client → skip
			[2, { user: { name: "NoCursor" } }], // no cursor → skip
			[3, { cursor, user: { name: "Other" } }],
		]);

		const carets = computeRemoteCarets(3, states, ytext, ydoc, 1);
		expect(carets).toHaveLength(1);
		expect(carets[0].name).toBe("Other");
	});

	test("missing user falls back to Anonymous + default color", () => {
		const ydoc = new Y.Doc();
		const ytext = ydoc.getText("content");
		ytext.insert(0, "abc");
		const states = new Map<number, unknown>([
			[2, { cursor: relCursor(ytext, 1, 1) }],
		]);

		const carets = computeRemoteCarets(3, states, ytext, ydoc, 1);
		expect(carets).toHaveLength(1);
		expect(carets[0].name).toBe("Anonymous");
		expect(typeof carets[0].color).toBe("string");
	});
});
