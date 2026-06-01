/**
 * Dynamically add/remove a yjs extension (yCollab) to a CodeMirror 6 EditorView.
 *
 * The caller owns the Compartment, so attach/detach can repeat on the same
 * EditorView and only trigger reconfigure.
 */

import type { Compartment, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export function attachYExtension(
	view: EditorView,
	compartment: Compartment,
	extension: Extension,
): void {
	view.dispatch({ effects: compartment.reconfigure(extension) });
}

export function detachYExtension(view: EditorView, compartment: Compartment): void {
	view.dispatch({ effects: compartment.reconfigure([]) });
}
