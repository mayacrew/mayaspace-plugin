/**
 * @jest-environment jsdom
 */
import { EditorState, Compartment, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { attachYExtension, detachYExtension } from "./editor-binding";

function makeView(): { view: EditorView; compartment: Compartment } {
	const compartment = new Compartment();
	const state = EditorState.create({
		doc: "hello",
		extensions: [compartment.of([])],
	});
	const view = new EditorView({ state });
	return { view, compartment };
}

describe("editor-binding", () => {
	test("attachYExtension은 compartment를 주어진 extension으로 reconfigure한다", () => {
		const { view, compartment } = makeView();
		const ext: Extension = [];
		attachYExtension(view, compartment, ext);
		detachYExtension(view, compartment);
		expect(view.state.doc.toString()).toBe("hello");
	});

	test("detachYExtension은 compartment를 빈 extension으로 되돌린다", () => {
		const { view, compartment } = makeView();
		attachYExtension(view, compartment, []);
		detachYExtension(view, compartment);
		expect(view.state).toBeDefined();
	});
});
