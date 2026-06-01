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
			await ensureParentFolders(vault, fullPath);
			await ensureFile(vault, fullPath);
		}
	}

	return result;
}

async function ensureFolder(vault: VaultLike, path: string): Promise<void> {
	if (vault.getAbstractFileByPath(path)) return;
	try {
		await vault.createFolder(path);
	} catch (e) {
		if (!isAlreadyExistsError(e)) throw e;
	}
}

async function ensureFile(vault: VaultLike, path: string): Promise<void> {
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

async function ensureParentFolders(vault: VaultLike, fullPath: string): Promise<void> {
	const segments = fullPath.split("/");
	segments.pop();
	let acc = "";
	for (const seg of segments) {
		acc = acc ? `${acc}/${seg}` : seg;
		await ensureFolder(vault, acc);
	}
}
