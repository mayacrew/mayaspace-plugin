import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { Annotation } from "@codemirror/state";
import type { Extension, Range } from "@codemirror/state";
import { yRemoteSelectionsTheme } from "y-codemirror.next";
import * as Y from "yjs";

export interface RemoteCaret {
	from: number;
	to: number;
	head: number;
	anchor: number;
	color: string;
	colorLight: string;
	name: string;
}

const DEFAULT_COLOR = "#30bced";

function clampIndex(i: number, len: number): number {
	return Math.max(0, Math.min(i, len));
}

// 원격 인덱스를 로컬 doc 길이 안으로 가둔다 — 이게 RangeError 크래시의 직접 차단점.
export function clampRange(start: number, end: number, docLen: number): { from: number; to: number } {
	const a = clampIndex(start, docLen);
	const b = clampIndex(end, docLen);
	return { from: Math.min(a, b), to: Math.max(a, b) };
}

interface AwarenessCursorState {
	cursor?: { anchor: unknown; head: unknown } | null;
	user?: { name?: string; color?: string; colorLight?: string };
}

// 원격 awareness 상태 → 로컬 doc 길이로 clamp된 캐럿 목록. 순수·결정적.
// 자기 자신·커서 없는 상태는 건너뛰고, 깨진 상태 하나가 전체를 죽이지 않게 per-state try/catch.
export function computeRemoteCarets(
	docLength: number,
	states: Map<number, unknown>,
	ytext: Y.Text,
	ydoc: Y.Doc,
	localClientId: number,
): RemoteCaret[] {
	const carets: RemoteCaret[] = [];
	states.forEach((raw, clientId) => {
		if (clientId === localClientId) return;
		try {
			const cursor = (raw as AwarenessCursorState)?.cursor;
			if (cursor == null || cursor.anchor == null || cursor.head == null) return;

			const anchorAbs = Y.createAbsolutePositionFromRelativePosition(cursor.anchor as Y.RelativePosition, ydoc);
			const headAbs = Y.createAbsolutePositionFromRelativePosition(cursor.head as Y.RelativePosition, ydoc);
			if (anchorAbs == null || headAbs == null || anchorAbs.type !== ytext || headAbs.type !== ytext) return;

			const { from, to } = clampRange(anchorAbs.index, headAbs.index, docLength);
			const user = (raw as AwarenessCursorState).user;
			const color = user?.color ?? DEFAULT_COLOR;
			carets.push({
				from,
				to,
				head: clampIndex(headAbs.index, docLength),
				anchor: clampIndex(anchorAbs.index, docLength),
				color,
				colorLight: user?.colorLight ?? `${color}33`,
				name: user?.name ?? "Anonymous",
			});
		} catch {
			// 한 클라이언트 상태가 깨졌어도 나머지·플러그인은 살린다(원래 desync의 근본 봉쇄).
		}
	});
	return carets;
}

// ---------- CodeMirror 어댑터 (얇은 연결부; 핵심 로직은 위 순수 함수) ----------

const remoteCursorsChanged = Annotation.define<boolean>();

interface YHandle {
	doc: Y.Doc;
	awareness: any;
}

// y-codemirror.next의 YRemoteCaretWidget와 동일한 클래스명(cm-ySelection*) → 익스포트된
// yRemoteSelectionsTheme가 그대로 스타일링한다.
class YRemoteCaretWidget extends WidgetType {
	constructor(
		private readonly color: string,
		private readonly name: string,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const caret = document.createElement("span");
		caret.className = "cm-ySelectionCaret";
		caret.style.backgroundColor = this.color;
		caret.style.borderColor = this.color;
		caret.append("⁠");
		const dot = document.createElement("div");
		dot.className = "cm-ySelectionCaretDot";
		caret.append(dot, "⁠");
		const info = document.createElement("div");
		info.className = "cm-ySelectionInfo";
		info.textContent = this.name;
		caret.append(info, "⁠");
		return caret;
	}

	eq(other: YRemoteCaretWidget): boolean {
		return other.color === this.color && other.name === this.name;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

class RemoteCursorsPluginValue {
	decorations: DecorationSet;
	private readonly ytext: Y.Text;
	private readonly localClientId: number;
	private readonly onAwareness: (c: { added: number[]; updated: number[]; removed: number[] }) => void;

	constructor(view: EditorView, private readonly handle: YHandle) {
		this.ytext = handle.doc.getText("content");
		this.localClientId = handle.doc.clientID;
		this.decorations = this.build(view);
		this.onAwareness = (c) => {
			const ids = [...c.added, ...c.updated, ...c.removed];
			// 내 변경만이면(로컬 커서 브로드캐스트) 다시 그릴 필요 없음 + update() 중 setLocalStateField가
			// 부른 동기 'change'에서 재진입 dispatch하는 것을 막는다.
			if (ids.length > 0 && ids.every((id) => id === this.localClientId)) return;
			if (view.composing) return; // IME 조합 중엔 미루고, 조합 끝난 트랜잭션에서 갱신.
			view.dispatch({ annotations: remoteCursorsChanged.of(true) });
		};
		handle.awareness.on("change", this.onAwareness);
	}

	update(update: ViewUpdate): void {
		this.writeLocalCursor(update);
		if (update.view.composing) return; // 조합 중엔 기존 데코 유지(IME 방해 방지).
		this.decorations = this.build(update.view);
	}

	destroy(): void {
		try {
			this.handle.awareness.off("change", this.onAwareness);
		} catch {
			/* awareness already gone */
		}
	}

	// 로컬 선택 → awareness.cursor(상대위치). 로컬 인덱스는 항상 로컬 doc 안이라 안전.
	private writeLocalCursor(update: ViewUpdate): void {
		const awareness = this.handle.awareness;
		const local = awareness.getLocalState();
		if (local == null) return;
		const sel = update.view.hasFocus ? update.state.selection.main : null;
		if (sel != null) {
			const anchor = Y.createRelativePositionFromTypeIndex(this.ytext, sel.anchor);
			const head = Y.createRelativePositionFromTypeIndex(this.ytext, sel.head);
			const cur = local.cursor;
			const curAnchor = cur ? Y.createRelativePositionFromJSON(cur.anchor) : null;
			const curHead = cur ? Y.createRelativePositionFromJSON(cur.head) : null;
			if (cur == null || !Y.compareRelativePositions(curAnchor, anchor) || !Y.compareRelativePositions(curHead, head)) {
				awareness.setLocalStateField("cursor", { anchor, head });
			}
		} else if (local.cursor != null) {
			awareness.setLocalStateField("cursor", null);
		}
	}

	// 클램프된 캐럿 → CodeMirror 데코. lineAt은 clamp된 값에만 호출하고, 전체를 try/catch로 감싼다.
	private build(view: EditorView): DecorationSet {
		try {
			const carets = computeRemoteCarets(
				view.state.doc.length,
				this.handle.awareness.getStates(),
				this.ytext,
				this.handle.doc,
				this.localClientId,
			);
			const ranges: Range<Decoration>[] = [];
			const pushMark = (from: number, to: number, colorLight: string) => {
				if (to <= from) return;
				ranges.push(
					Decoration.mark({
						class: "cm-ySelection",
						attributes: { style: `background-color:${colorLight}` },
					}).range(from, to),
				);
			};
			for (const c of carets) {
				if (c.from !== c.to) {
					const startLine = view.state.doc.lineAt(c.from);
					const endLine = view.state.doc.lineAt(c.to);
					if (startLine.number === endLine.number) {
						pushMark(c.from, c.to, c.colorLight);
					} else {
						pushMark(c.from, startLine.to, c.colorLight);
						for (let i = startLine.number + 1; i < endLine.number; i++) {
							const line = view.state.doc.line(i);
							ranges.push(
								Decoration.line({
									attributes: { class: "cm-yLineSelection", style: `background-color:${c.colorLight}` },
								}).range(line.from),
							);
						}
						pushMark(endLine.from, c.to, c.colorLight);
					}
				}
				ranges.push(
					Decoration.widget({
						widget: new YRemoteCaretWidget(c.color, c.name),
						side: c.head - c.anchor > 0 ? -1 : 1,
					}).range(c.head),
				);
			}
			return Decoration.set(ranges, true);
		} catch {
			return Decoration.none;
		}
	}
}

// yRemoteSelectionsTheme는 이름 라벨(cm-ySelectionInfo)을 opacity:0으로 두고 캐럿 hover 시에만
// 보여준다. 공유 닉네임/로그인 아이디가 바로 뜨도록 항상 보이게 덮어쓴다(theme이 baseTheme보다 우선).
const labelAlwaysVisible = EditorView.theme({
	".cm-ySelectionInfo": { opacity: 1 },
});

// yCollab-binder가 ext에 추가. ySync(본문 동기화)와 독립적으로 원격 커서/선택만 담당.
export function remoteCursors(handle: { doc: Y.Doc; awareness: unknown }): Extension {
	const plugin = ViewPlugin.define(
		(view) => new RemoteCursorsPluginValue(view, handle as YHandle),
		{ decorations: (v) => v.decorations },
	);
	return [plugin, yRemoteSelectionsTheme, labelAlwaysVisible];
}
