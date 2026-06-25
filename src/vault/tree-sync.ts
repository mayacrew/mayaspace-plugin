/**
 * MayaSpace org tree → Obsidian vault local mirroring.
 *
 * After login, each org is mapped to `<mayaspaceRoot>/<sanitized-org-name>/`
 * and each server file is ensured as a 0-byte placeholder. Real content is
 * fetched lazily when the user opens the file — the Y.Doc binding pulls it
 * in via Hocuspocus.
 *
 * The caller (main.ts) receives mappings via onFileMapped/onOrgMapped before
 * vault.create fires, so vault.on('create') handlers can distinguish our
 * placeholders from user-created files.
 */

import type { Org, FileMeta } from "../api/mayaspace-api";
import { sanitizeFolderName } from "../lib/path";

export interface VaultLike {
	getAbstractFileByPath(path: string): unknown | null;
	createFolder(path: string): Promise<unknown>;
	create(path: string, content: string): Promise<unknown>;
	delete?(path: string): Promise<void>;
}

export interface ApiLike {
	listOrgs(): Promise<Org[]>;
	getTree(orgId: string): Promise<FileMeta[]>;
}

export interface FileMapping {
	orgId: string;
	fileId: string;
}

export interface SyncOptions {
	mayaspaceRoot: string;
	/**
	 * Called whenever a mapping is decided, BEFORE ensureFile invokes
	 * vault.create. Lets the caller update file-mappings synchronously so
	 * the resulting vault.on('create') event can detect it's our placeholder.
	 */
	onFileMapped?: (path: string, mapping: FileMapping) => void;
	onOrgMapped?: (folderName: string, orgId: string) => void;
	/**
	 * Called ONCE after listOrgs returns with the full org → effective_permissions
	 * map. Use this to refresh the plugin's permission cache atomically.
	 * Orgs whose response omits effective_permissions fall back to 0
	 * (no access — safest default).
	 */
	onOrgPermissions?: (perms: Record<string, number>) => void | Promise<void>;
	/** 파일별 effective_permissions 전달. 캐시 갱신용. */
	onFilePermissions?: (fileId: string, perms: number) => void;
}

export interface SyncResult {
	/** sanitized org folder name → orgId */
	orgs: Record<string, string>;
	/** full vault path → fileId/orgId */
	files: Record<string, FileMapping>;
}

export async function syncOrgTrees(
	vault: VaultLike,
	api: ApiLike,
	opts: SyncOptions,
): Promise<SyncResult> {
	const result: SyncResult = { orgs: {}, files: {} };

	await ensureFolder(vault, opts.mayaspaceRoot);

	const orgs = await api.listOrgs();

	if (opts.onOrgPermissions) {
		const perms: Record<string, number> = {};
		for (const o of orgs) perms[o.id] = o.effective_permissions ?? 0;
		await opts.onOrgPermissions(perms);
	}

	for (const org of orgs) {
		const folderName = sanitizeFolderName(org.name);
		result.orgs[folderName] = org.id;
		opts.onOrgMapped?.(folderName, org.id);

		const orgFolder = `${opts.mayaspaceRoot}/${folderName}`;
		await ensureFolder(vault, orgFolder);

		const files = await api.getTree(org.id);
		for (const file of files) {
			const fullPath = `${orgFolder}/${file.path}`;
			const mapping = { orgId: org.id, fileId: file.id };
			result.files[fullPath] = mapping;
			opts.onFileMapped?.(fullPath, mapping);
			opts.onFilePermissions?.(file.id, file.effective_permissions ?? 0);
			await ensureParentFolders(vault, fullPath);
			await ensureFile(vault, fullPath);
		}
	}

	return result;
}

/**
 * 로컬에만 있고 서버/매핑에 없는 파일 = 누락된 create 이벤트로 고아가 된 파일.
 * org 폴더(<root>/<orgFolder>/) 안의 것만 업로드 후보로 돌려준다(순수 함수).
 *
 * NFC로 정규화해 비교한다 — macOS는 한글 파일명을 NFD로 다루는데, 서버 경로(NFC)와
 * byte 비교하면 같은 파일이 고아로 잘못 잡혀 재업로드(409)가 반복된다.
 *
 * @param localFiles 모든 로컬 파일의 vault 경로
 * @param knownPaths 서버 트리 + 기존 매핑에 이미 있는 경로(정상 동기화된 것)
 * @param orgFolders sanitized org 폴더 이름들
 * @returns 업로드해야 할 고아 파일들(원본 경로 그대로 — 호출부가 vault API에 쓴다)
 */
export function findUnmappedLocalFiles(
	localFiles: string[],
	knownPaths: Iterable<string>,
	mayaspaceRoot: string,
	orgFolders: Iterable<string>,
): string[] {
	const known = new Set<string>();
	for (const p of knownPaths) known.add(p.normalize("NFC"));
	const orgPrefixes = Array.from(orgFolders, (f) => `${mayaspaceRoot}/${f}/`.normalize("NFC"));

	const out: string[] = [];
	for (const path of localFiles) {
		const nfc = path.normalize("NFC");
		if (known.has(nfc)) continue;
		if (!orgPrefixes.some((prefix) => nfc.startsWith(prefix))) continue;
		out.push(path);
	}
	return out;
}

/**
 * 드랍된 폴더(folderPath) 하위의, 매핑 안 된 org 폴더 내 파일들. 폴더 드래그앤드랍 시
 * Obsidian이 안쪽 파일마다 create를 안정적으로 발화하지 않는 문제를 보완해 일괄 업로드 대상을 돌려준다.
 * 마크다운·첨부 모두 포함하려면 localFiles에 둘 다 넣어 호출한다(getFiles()). 순수 함수.
 */
export function findUnmappedFilesUnderFolder(
	folderPath: string,
	localFiles: string[],
	knownPaths: Iterable<string>,
	mayaspaceRoot: string,
	orgFolders: Iterable<string>,
): string[] {
	// 슬래시 경계로 접두 비교해 형제 폴더(drop vs drop2) 오탐을 막는다.
	const prefix = `${folderPath}/`.normalize("NFC");
	const under = localFiles.filter((p) => p.normalize("NFC").startsWith(prefix));
	return findUnmappedLocalFiles(under, knownPaths, mayaspaceRoot, orgFolders);
}

/**
 * 동기화 직전 매핑(before) 중, 권위 있는 재동기화 결과(result)의 서버 트리에서 사라진 것 =
 * 권한 회수(또는 삭제)된 파일을 돌려준다(순수 함수). 호출부가 이 파일들의 로컬 .md·CRDT·세션을
 * 지운다 — runTreeSync는 매핑을 서버 트리로 통째 교체하기만 해서, 회수된 파일의 로컬 흔적이
 * 매핑만 빠진 채 고아로 남기 때문이다.
 *
 * - 이번에 동기화된 org(result.orgs)만 대상 — 동기화 실패/누락된 org는 건드리지 않는다(안전).
 * - fileId가 result에 여전히 있으면 이동(다른 경로로)이므로 회수가 아니다 — 제외한다.
 * - 경로는 NFC로 정규화해 비교한다(macOS NFD 매핑 키 ↔ 서버 NFC 경로 오판 방지).
 */
export function findRevokedMappings(
	before: Record<string, FileMapping>,
	result: SyncResult,
): Array<[string, FileMapping]> {
	const syncedOrgIds = new Set(Object.values(result.orgs));
	const serverPaths = new Set(Object.keys(result.files).map((p) => p.normalize("NFC")));
	const serverFileIds = new Set(Object.values(result.files).map((m) => m.fileId));

	const revoked: Array<[string, FileMapping]> = [];
	for (const [path, mapping] of Object.entries(before)) {
		if (!syncedOrgIds.has(mapping.orgId)) continue;
		if (serverPaths.has(path.normalize("NFC"))) continue;
		if (serverFileIds.has(mapping.fileId)) continue;
		revoked.push([path, mapping]);
	}
	return revoked;
}

async function ensureFolder(vault: VaultLike, path: string): Promise<void> {
	if (vault.getAbstractFileByPath(path)) return;
	try {
		await vault.createFolder(path);
	} catch (e) {
		if (!isAlreadyExistsError(e)) throw e;
	}
}

export async function ensureFile(vault: VaultLike, path: string): Promise<void> {
	if (vault.getAbstractFileByPath(path)) return;
	try {
		await vault.create(path, "");
	} catch (e) {
		if (!isAlreadyExistsError(e)) throw e;
	}
}

function isAlreadyExistsError(e: unknown): boolean {
	const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
	return msg.includes("already exists");
}

export async function ensureParentFolders(vault: VaultLike, fullPath: string): Promise<void> {
	const segments = fullPath.split("/");
	segments.pop();
	let acc = "";
	for (const seg of segments) {
		acc = acc ? `${acc}/${seg}` : seg;
		await ensureFolder(vault, acc);
	}
}
