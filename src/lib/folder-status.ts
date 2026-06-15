/**
 * 파일 탐색기 폴더에 표시할 동기화 상태를 하위 파일들로부터 집계한다.
 *
 * SyncStatus 정의의 단일 출처. explorer-decorator가 이 타입을 re-export 하므로
 * ui → lib 단방향 의존을 유지한다.
 */
export type SyncStatus = "idle" | "syncing" | "connected" | "conflict" | "offline";

// 폴더 배지는 "가장 주의가 필요한 자식"을 보여준다. 숫자가 클수록 우선한다.
//   conflict: 충돌(빨강) — 가장 시급
//   syncing : 진행 중
//   offline : 동기화 안 됨 — 문제를 드러낸다
//   connected: 라이브 세션(긍정 신호)
//   idle    : 매핑됐지만 세션 없음(평상 상태) — 바닥값
const PRIORITY: Record<SyncStatus, number> = {
	conflict: 5,
	syncing: 4,
	offline: 3,
	connected: 2,
	idle: 1,
};

/** "a/b/c.md" → ["a", "a/b"]. 얕은→깊은 순. 루트 파일은 []. */
export function ancestorFolders(filePath: string): string[] {
	const parts = filePath.split("/");
	const folders: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		folders.push(parts.slice(0, i).join("/"));
	}
	return folders;
}

/**
 * 파일 경로 목록과 파일별 상태로부터 폴더 경로 → 집계 상태를 만든다.
 * 각 폴더는 자신의 모든 하위 파일 중 우선순위가 가장 높은 상태를 갖는다.
 * 상태가 없는 파일은 idle로 본다.
 */
export function deriveFolderStatuses(
	filePaths: string[],
	statuses: Record<string, SyncStatus>,
): Record<string, SyncStatus> {
	const result: Record<string, SyncStatus> = {};
	for (const filePath of filePaths) {
		const status = statuses[filePath] ?? "idle";
		for (const folder of ancestorFolders(filePath)) {
			const current = result[folder];
			if (current === undefined || PRIORITY[status] > PRIORITY[current]) {
				result[folder] = status;
			}
		}
	}
	return result;
}
