/**
 * Single source of truth for vault path ↔ MayaSpace (orgId, fileId) mappings.
 *
 * Why a separate module: tree-sync, vault.on(create/rename/delete), the SSE
 * subscriber, file-open, and the explorer decorator all need to read and
 * mutate this map. Centralising it removes the scatter that led to drift
 * in the previous plugin (one handler updating settings.fileMappings while
 * another saw a stale snapshot mid-event).
 *
 * Persistence is delegated — the host wires save()/load() to plugin.saveData.
 */

import type { FileMapping } from "./tree-sync";

export interface FileMappingsHost {
	getFiles(): Record<string, FileMapping>;
	setFiles(files: Record<string, FileMapping>): Promise<void>;
	getOrgs(): Record<string, string>;
	setOrgs(orgs: Record<string, string>): Promise<void>;
}

export type Listener = () => void;

export class FileMappings {
	private listeners = new Set<Listener>();

	constructor(private host: FileMappingsHost) {}

	get files(): Record<string, FileMapping> {
		return this.host.getFiles();
	}

	get orgs(): Record<string, string> {
		return this.host.getOrgs();
	}

	getFile(path: string): FileMapping | null {
		return this.files[path] ?? null;
	}

	getOrgIdByFolder(folderName: string): string | null {
		return this.orgs[folderName] ?? null;
	}

	async setFile(path: string, mapping: FileMapping): Promise<void> {
		const files = { ...this.files, [path]: mapping };
		await this.host.setFiles(files);
		this.fire();
	}

	async removeFile(path: string): Promise<void> {
		const files = { ...this.files };
		delete files[path];
		await this.host.setFiles(files);
		this.fire();
	}

	async renameFile(oldPath: string, newPath: string): Promise<void> {
		const files = { ...this.files };
		const mapping = files[oldPath];
		if (!mapping) return;
		delete files[oldPath];
		files[newPath] = mapping;
		await this.host.setFiles(files);
		this.fire();
	}

	async setOrg(folderName: string, orgId: string): Promise<void> {
		const orgs = { ...this.orgs, [folderName]: orgId };
		await this.host.setOrgs(orgs);
		this.fire();
	}

	async replaceAll(orgs: Record<string, string>, files: Record<string, FileMapping>): Promise<void> {
		await this.host.setOrgs(orgs);
		await this.host.setFiles(files);
		this.fire();
	}

	findFileIdByOrgAndPath(orgId: string, relPath: string): string | null {
		for (const [path, mapping] of Object.entries(this.files)) {
			if (mapping.orgId !== orgId) continue;
			if (path.endsWith("/" + relPath) || path === relPath) return mapping.fileId;
		}
		return null;
	}

	onChange(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private fire(): void {
		for (const l of this.listeners) {
			try { l(); } catch (e) { console.warn("[mayaspace] mapping listener", e); }
		}
	}
}
