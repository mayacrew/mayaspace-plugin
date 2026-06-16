/**
 * 백그라운드 prefetch가 서버 내용(ytext)을 로컬 vault 파일에 반영할지 결정한다.
 *
 * write 권한이 있는 파일은 로컬에 사용자 편집이 있을 수 있으므로 빈 placeholder만 채우고,
 * non-empty 파일의 머지는 파일을 열 때 yCollab attach에 위임한다(prefetch가 편집을 덮어쓰지 않게).
 *
 * read-only 파일은 사용자가 편집할 수 없어 보호할 로컬 편집이 없다. 따라서 non-empty여도 서버
 * 내용으로 덮어써서 동기화를 유지한다 — readonly 사용자가 yCollab attach 없이도 최신 본문을 받는다.
 */
export function shouldApplyPrefetch(currentLocal: string, incoming: string, writable: boolean): boolean {
	if (currentLocal === incoming) return false;
	if (!writable) return true;
	return currentLocal.length === 0;
}
