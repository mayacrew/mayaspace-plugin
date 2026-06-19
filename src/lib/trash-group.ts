/**
 * 휴지통 복구는 서버에 org 단위로 호출한다(엔드포인트가 org별).
 * 모달에서 선택된 fileId들을 org별 버킷으로 묶는 순수 함수 — obsidian 비의존이라 단위 테스트 대상.
 */
export interface TrashRow {
	orgId: string;
	id: string;
	path: string;
	deleted_at: string;
}

export function groupFileIdsByOrg(rows: TrashRow[], selected: Set<string>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const row of rows) {
		if (!selected.has(row.id)) continue;
		(out[row.orgId] ??= []).push(row.id);
	}
	return out;
}
