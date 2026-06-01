/**
 * @jest-environment jsdom
 *
 * Integration test for bindYCollab — real CodeMirror 6 EditorView, real
 * Y.Doc, real Awareness. The only thing we mock is the DOM container.
 *
 * Goals:
 *   1. Each reconcile branch reaches the expected end state
 *      (ytext.toString() === editor.state.doc.toString() in all cases).
 *   2. The user's offline body in vault.md is preserved when the CRDT
 *      starts empty (most important — this is the data-loss case).
 *   3. After bind, editor → ytext sync works (i.e. ySyncPlugin is actually
 *      wired in).
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { bindYCollab } from "./yCollab-binder";

function makeView(initial: string): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const state = EditorState.create({ doc: initial });
	return new EditorView({ state, parent });
}

function makeIdentity() {
	return {
		name: "Tester",
		color: "hsl(180, 70%, 50%)",
		colorLight: "hsla(180, 70%, 50%, 0.2)",
	};
}

// Suppress the binder's noisy console logs in test output.
beforeEach(() => {
	jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
	(console.log as jest.Mock).mockRestore?.();
});

describe("bindYCollab — reconcile branches", () => {
	test("CRDT empty + editor has body → body is pushed into ytext", () => {
		// This is the offline-edit-preservation case: user typed in vault
		// while offline, ytext arrived empty (server didn't have it yet
		// and IndexedDB had nothing to restore for a brand-new file).
		const view = makeView("로컬에서 편집한 본문");
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());

		expect(doc.getText("content").toString()).toBe("로컬에서 편집한 본문");
		expect(view.state.doc.toString()).toBe("로컬에서 편집한 본문");

		unbind();
		view.destroy();
	});

	test("ytext has body + editor empty → editor resets to ytext", () => {
		// Plugin loaded after IndexedDB already had content (or the server
		// hydrated ytext first); the vault.md is the empty placeholder.
		const view = makeView("");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "서버에서 받은 본문");
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());

		expect(view.state.doc.toString()).toBe("서버에서 받은 본문");
		expect(doc.getText("content").toString()).toBe("서버에서 받은 본문");

		unbind();
		view.destroy();
	});

	test("both non-empty and differ → ytext is the merged truth, editor resets", () => {
		// vault.md is the previously-dumped editor body (stale relative
		// to the freshly-merged ytext). Binder must reset editor → ytext,
		// NOT push the stale editor body into ytext.
		const view = makeView("옛 vault.md 본문");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "병합된 최신 본문");
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());

		expect(doc.getText("content").toString()).toBe("병합된 최신 본문");
		expect(view.state.doc.toString()).toBe("병합된 최신 본문");

		unbind();
		view.destroy();
	});

	test("both equal → no change, ext attached", () => {
		const view = makeView("같음");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "같음");
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());

		expect(view.state.doc.toString()).toBe("같음");
		expect(doc.getText("content").toString()).toBe("같음");

		unbind();
		view.destroy();
	});

	test("awareness.user is populated for remote-cursor rendering", () => {
		const view = makeView("");
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		const identity = makeIdentity();

		const unbind = bindYCollab(view, { doc, awareness }, identity);

		// Without user state, peers see anonymous cursors. The binder must
		// set it on local awareness.
		const localState = awareness.getLocalState();
		expect(localState).toMatchObject({ user: identity });

		unbind();
		view.destroy();
	});
});

describe("bindYCollab — live sync after attach", () => {
	test("editor edit propagates to ytext (ySyncPlugin is wired)", async () => {
		const view = makeView("");
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());

		// Simulate a user keystroke after the binding is in place.
		view.dispatch({ changes: { from: 0, insert: "hello" } });
		// yCollab pushes via a microtask; flush.
		await Promise.resolve();

		expect(doc.getText("content").toString()).toBe("hello");

		unbind();
		view.destroy();
	});

	test("ytext change propagates to editor (ySyncPlugin observe is wired)", async () => {
		const view = makeView("");
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());

		// Simulate a remote update arriving on ytext (e.g. via Hocuspocus).
		doc.getText("content").insert(0, "remote-arrived");
		await Promise.resolve();

		expect(view.state.doc.toString()).toBe("remote-arrived");

		unbind();
		view.destroy();
	});
});

describe("bindYCollab — unbind cleanup", () => {
	test("calling unbind() doesn't throw and leaves editor usable", () => {
		const view = makeView("base");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "base");
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());
		expect(() => unbind()).not.toThrow();

		// Editor still functional after unbind.
		view.dispatch({ changes: { from: 4, insert: " ok" } });
		expect(view.state.doc.toString()).toBe("base ok");

		view.destroy();
	});
});
