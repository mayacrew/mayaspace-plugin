/**
 * Bind a Hocuspocus-backed Y.Doc to a CodeMirror 6 EditorView via yCollab.
 *
 * Two things have to be true at bind time, or live edits go wrong:
 *  1. editor doc and ytext must agree on the initial content. y-codemirror.next
 *     doesn't reconcile on attach — it only observes subsequent changes — so a
 *     mismatch causes ytext's first update to insert as a duplicate prefix.
 *  2. awareness.user must be set BEFORE the extension is added, otherwise
 *     remote peers see anonymous cursors with no label.
 *
 * Returns an unbind function that empties the compartment and removes the
 * IME diagnostic listeners.
 */

import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ySync, ySyncFacet, YSyncConfig } from "y-codemirror.next";
import * as Y from "yjs";
import { detachYExtension } from "./editor-binding";
import type { PeerIdentity } from "../ui/peer-identity";

export interface YCollabHandle {
	doc: Y.Doc;
	awareness: any;
}

export function bindYCollab(
	view: EditorView,
	handle: YCollabHandle,
	identity: PeerIdentity,
): () => void {
	const compartment = new Compartment();
	const ytext = handle.doc.getText("content");
	const ytextStr = ytext.toString();

	handle.awareness.setLocalStateField("user", identity);

	// Build the content-sync core WITHOUT yCollab's yRemoteSelections. That
	// plugin's update() calls editor.doc.lineAt(index) with an index resolved
	// against the shared Y.Doc; when the local editor lags ytext (Korean IME
	// composition defers CodeMirror transactions while remote edits stream in)
	// the index exceeds the editor doc length → RangeError → the ViewPlugin
	// dies and the client stops applying remote updates (one-sided desync).
	// Dropping remote-cursor rendering removes the crash; content sync stays.
	const ext = [ySyncFacet.of(new YSyncConfig(ytext, handle.awareness)), ySync];

	// Probe whether ytext is recognised as the same Y.Text class our bundle
	// knows about. If instanceof fails, ySyncPlugin will silently refuse to
	// push editor changes — that's the "ytext stuck at N" symptom.
	const isYText = ytext instanceof Y.Text;
	const ctorName = (ytext as any).constructor?.name;
	console.log(
		`[mayaspace] bindYCollab applied, ytext.length=${ytext.length} instanceof Y.Text=${isYText} ctor=${ctorName}`,
	);
	const observer = () => console.log("[mayaspace] ytext changed → length =", ytext.length);
	ytext.observe(observer);

	// IME diagnostic — Korean/Japanese composition can race with ytext updates.
	const onCompStart = () => logIme("start", view, ytext);
	const onCompEnd = (e: Event) =>
		logIme(`end data="${(e as CompositionEvent).data}"`, view, ytext);
	view.contentDOM.addEventListener("compositionstart", onCompStart);
	view.contentDOM.addEventListener("compositionend", onCompEnd);

	// editor → ytext sync diagnostic. If editor doc grows but ytext.after stays
	// at ytext.before across a docChanged, the ySyncPlugin is broken — usually
	// because Y.Text instanceof checks fail (two yjs modules loaded).
	const syncDiag = EditorView.updateListener.of((u) => {
		if (!u.docChanged) return;
		const before = ytext.length;
		queueMicrotask(() => {
			console.log(
				`[mayaspace SYNC] docChanged editor=${u.state.doc.length} ytext.before=${before} ytext.after=${ytext.length}`,
			);
		});
	});

	// Single transaction: reconcile editor doc to ytext AND attach yCollab.
	// y-codemirror.next's ySyncPlugin does not reconcile on init — it only
	// observes future changes — so editor doc and ytext must be equal at
	// attach time. Two separate dispatches leave a window where ySyncPlugin
	// silently breaks. The demo client recreates EditorState; inside
	// Obsidian we use a single transaction.
	//
	// Reconcile direction matters for offline-edit safety:
	//   - ytext empty + editor has content → vault.md is filled but the
	//     CRDT doc isn't (placeholder being opened first time, or fresh
	//     Y.Doc that hasn't loaded from IndexedDB yet). Push editor into
	//     ytext so the local body is preserved as a CRDT insert.
	//   - both non-empty and different → trust ytext. With IndexedDB
	//     persistence the ytext already contains the user's offline edits
	//     merged with whatever the server sent, so ytext IS the merged
	//     truth. Earlier this branch silently dropped offline edits because
	//     ytext was being seeded fresh from the server.
	const editorStr = view.state.doc.toString();
	const tx: {
		changes?: { from: number; to: number; insert: string };
		effects: StateEffect<unknown>;
	} = {
		effects: StateEffect.appendConfig.of(compartment.of([ext, syncDiag])),
	};
	if (ytextStr.length === 0 && editorStr.length > 0) {
		// CRDT-side empty, vault-side has content. Push to ytext as a real
		// insert (not the editor-doc reset path) so peers and IndexedDB
		// observe it as a normal CRDT update.
		ytext.insert(0, editorStr);
		console.log("[mayaspace] reconcile: editor → ytext (CRDT was empty), len=", editorStr.length);
	} else if (ytextStr !== editorStr) {
		// ytext is the merged truth. Replace editor doc inside this same
		// transaction so ySyncPlugin starts with both sides agreeing.
		tx.changes = { from: 0, to: view.state.doc.length, insert: ytextStr };
		console.log("[mayaspace] reconcile: ytext → editor (ytext is merged truth)");
	}
	view.dispatch(tx);

	// Post-attach probe (next microtask): can we push to ytext directly? If
	// this works but editor → ytext sync still doesn't, the wiring between
	// yCollab and our compartment is the culprit (not Y.Text identity).
	queueMicrotask(() => {
		const beforeLen = ytext.length;
		try {
			ytext.insert(beforeLen, "");
			console.log(`[mayaspace] post-attach ytext probe OK len=${ytext.length}, editor.doc=${view.state.doc.length}`);
		} catch (e) {
			console.error("[mayaspace] post-attach ytext probe FAIL:", e);
		}
	});

	return () => {
		try {
			view.contentDOM.removeEventListener("compositionstart", onCompStart);
			view.contentDOM.removeEventListener("compositionend", onCompEnd);
		} catch { /* view destroyed */ }
		try { ytext.unobserve(observer); } catch { /* doc destroyed */ }
		try {
			detachYExtension(view, compartment);
		} catch { /* view destroyed */ }
	};
}

function logIme(label: string, view: EditorView, ytext: Y.Text): void {
	console.log(`[mayaspace IME] ${label} ytext=${ytext.length} editor=${view.state.doc.length}`);
}
