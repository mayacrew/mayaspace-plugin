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

describe("bindYCollab — read-only mode", () => {
	test("readOnly:true 면 에디터가 read-only로 설정된다 (사용자 입력 차단)", () => {
		const view = makeView("서버 본문");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "서버 본문");
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity(), { readOnly: true });

		expect(view.state.readOnly).toBe(true);
		expect(view.state.facet(EditorView.editable)).toBe(false);

		unbind();
		view.destroy();
	});

	test("readOnly:true 여도 원격 ytext 변경은 계속 에디터에 반영된다 (읽기 동기화 유지)", async () => {
		const view = makeView("");
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity(), { readOnly: true });

		// 서버에서 온 원격 업데이트(Hocuspocus가 ytext에 적용하는 것과 동일).
		doc.getText("content").insert(0, "원격에서 도착");
		await Promise.resolve();

		expect(view.state.doc.toString()).toBe("원격에서 도착");

		unbind();
		view.destroy();
	});

	test("readOnly:true + 서버(ytext) 비어있고 에디터에 로컬 편집 → ytext로 밀어넣지 않고 에디터를 비운다 (서버가 진실)", () => {
		// readonly 전환 직전 창에서 사용자가 친 로컬 내용. read-only면 서버 문서만 남아야 하므로
		// 로컬은 ytext로 올라가서도 안 되고(서버 오염), 에디터에도 남아서도 안 된다.
		const view = makeView("readonly인데 친 로컬 내용");
		const doc = new Y.Doc(); // ytext 비어있음 = 서버 문서 비어있음
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity(), { readOnly: true });

		expect(doc.getText("content").toString()).toBe("");
		expect(view.state.doc.toString()).toBe("");

		unbind();
		view.destroy();
	});

	test("readOnly:true + 서버/로컬이 다름 → 에디터를 서버 내용으로 리셋하고 로컬은 버린다", () => {
		const view = makeView("로컬 편집본");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "서버 본문");
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity(), { readOnly: true });

		expect(view.state.doc.toString()).toBe("서버 본문");
		expect(doc.getText("content").toString()).toBe("서버 본문");

		unbind();
		view.destroy();
	});

	test("옵션 없으면(기본) 에디터는 편집 가능 상태를 유지한다 (회귀 방지)", () => {
		const view = makeView("본문");
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "본문");
		const awareness = new Awareness(doc);

		const unbind = bindYCollab(view, { doc, awareness }, makeIdentity());

		expect(view.state.readOnly).toBe(false);
		expect(view.state.facet(EditorView.editable)).toBe(true);

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
