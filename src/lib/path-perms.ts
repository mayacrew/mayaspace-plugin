/**
 * 새 파일 경로의 권한을 추정한다(클라 생성 가드용).
 *
 * 서버 ACL은 경로 prefix로 상속된다. 그래서 새 파일의 권한은 "가장 가까운 조상 폴더(또는 같은 폴더)
 * 아래에 이미 매핑된 파일"의 권한을 물려받아야 한다.
 *
 * 과거엔 직속 형제(같은 폴더)만 봤다 — 폴더째 드래그로 생긴 **새 하위폴더**의 파일들은 형제가 없어
 * org 루트 권한으로 잘못 폴백했고, 루트에 CREATE가 없으면 업로드가 조용히 막혔다(회귀). 이제 조상까지
 * 거슬러 올라가 가장 가까운 조상의 권한을 쓰고, 그래도 못 찾을 때만 org 루트 권한으로 폴백한다.
 */
export function inheritedPermsForPath(
	orgId: string,
	fullPath: string,
	fileMappings: Record<string, { orgId: string; fileId: string }>,
	filePermissions: Record<string, number>,
	orgRootPerms: number,
): number {
	let bestPerms: number | undefined;
	let bestDirLen = -1;
	for (const [mappedPath, mapping] of Object.entries(fileMappings)) {
		if (mapping.orgId !== orgId) continue;
		const dir = mappedPath.slice(0, mappedPath.lastIndexOf("/"));
		// dir가 fullPath와 같은 폴더이거나 그 조상이어야 한다(prefix 상속). 가장 깊은(가까운) 조상이 이긴다.
		if (!fullPath.startsWith(dir + "/")) continue;
		const perms = filePermissions[mapping.fileId];
		if (perms === undefined) continue;
		if (dir.length > bestDirLen) {
			bestPerms = perms;
			bestDirLen = dir.length;
		}
	}
	return bestPerms ?? orgRootPerms;
}
