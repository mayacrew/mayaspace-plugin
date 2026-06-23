/**
 * 본문 하이드레이션 상태를 폴더로 집계한다.
 *
 * sync 상태(folder-status.ts)와 직교한다: sync는 "실시간 협업 연결",
 * content는 "본문이 로컬에 있나". 같은 파일이 local이면서 offline일 수 있다.
 */
import { ancestorFolders } from "./folder-status";

export type ContentState = "local" | "hydrating" | "placeholder";

// 폴더 배지는 "아직 다 못 받은" 신호를 드러낸다. 숫자가 클수록 우선한다.
//   placeholder: 본문 없음 — 가장 두드러져야(아직 안 받음)
//   hydrating  : 받는 중
//   local      : 본문 있음(긍정·바닥값) — 추가 표시 없음
const PRIORITY: Record<ContentState, number> = {
	placeholder: 3,
	hydrating: 2,
	local: 1,
};

/**
 * 파일 경로 목록과 파일별 content 상태로부터 폴더 경로 → 집계 상태를 만든다.
 * 각 폴더는 자신의 모든 하위 파일 중 우선순위가 가장 높은 상태를 갖는다.
 * 상태가 없는 파일은 placeholder로 본다(아직 안 받은 것으로 간주).
 */
export function deriveFolderContentStates(
	filePaths: string[],
	states: Record<string, ContentState>,
): Record<string, ContentState> {
	const result: Record<string, ContentState> = {};
	for (const filePath of filePaths) {
		const state = states[filePath] ?? "placeholder";
		for (const folder of ancestorFolders(filePath)) {
			const current = result[folder];
			if (current === undefined || PRIORITY[state] > PRIORITY[current]) {
				result[folder] = state;
			}
		}
	}
	return result;
}
