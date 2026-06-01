/**
 * Periodic reconciliation of server-side tree changes.
 *
 * MayaSpace's SSE stream (mayaspace-events.ts) emits content updates but does
 * not yet broadcast tree changes (server issue #3). A second client creating
 * a file would never appear in our vault until the user manually re-synced.
 *
 * This poller refetches each org's tree every `intervalMs` and applies a
 * diff: new files become placeholder ensures, deleted files are removed from
 * the vault and mappings. Stop on logout / settings change.
 */

import type { Org, FileMeta } from "../api/mayaspace-api";

export interface PollerApi {
	listOrgs(): Promise<Org[]>;
	getTree(orgId: string): Promise<FileMeta[]>;
}

export interface PollerVault {
	getAbstractFileByPath(path: string): unknown | null;
	create(path: string, content: string): Promise<unknown>;
	createFolder(path: string): Promise<unknown>;
	delete(path: string | unknown): Promise<void>;
}

export interface PollerHooks {
	/** Map full vault path → known mapping. Used to find local files for deletion. */
	getKnownFiles(): Record<string, { orgId: string; fileId: string }>;
	addFileMapping(path: string, mapping: { orgId: string; fileId: string }): Promise<void>;
	removeFileMapping(path: string): Promise<void>;
	sanitizeOrgFolderName(name: string): string;
	mayaspaceRoot(): string;
	/**
	 * Called once per tick with the full org → effective_permissions snapshot.
	 * Without this, admin's permission changes never reach the plugin until
	 * the next explicit syncTrees (logout/relogin or manual "Sync now").
	 */
	onOrgPermissions?(perms: Record<string, number>): Promise<void> | void;
	onError?(e: unknown): void;
}

export class TreePoller {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(
		private api: PollerApi,
		private vault: PollerVault,
		private hooks: PollerHooks,
		private intervalMs: number,
	) {}

	start(): void {
		if (this.timer) return;
		if (this.intervalMs <= 0) return;
		this.timer = setInterval(() => this.tick(), this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const orgs = await this.api.listOrgs();
			if (this.hooks.onOrgPermissions) {
				const perms: Record<string, number> = {};
				for (const o of orgs) perms[o.id] = o.effective_permissions ?? 0;
				await this.hooks.onOrgPermissions(perms);
			}
			for (const org of orgs) {
				await this.reconcileOrg(org);
			}
		} catch (e) {
			this.hooks.onError?.(e);
		} finally {
			this.running = false;
		}
	}

	private async reconcileOrg(org: Org): Promise<void> {
		const folderName = this.hooks.sanitizeOrgFolderName(org.name);
		const orgFolder = `${this.hooks.mayaspaceRoot()}/${folderName}`;
		const tree = await this.api.getTree(org.id);

		const serverPaths = new Set<string>();
		for (const file of tree) {
			const fullPath = `${orgFolder}/${file.path}`;
			serverPaths.add(fullPath);
			const known = this.hooks.getKnownFiles()[fullPath];
			if (known && known.fileId === file.id) continue;

			await this.ensureParents(fullPath);
			// Register mapping BEFORE creating the placeholder. vault.create
			// fires the plugin's vault.on('create') handler synchronously; if
			// the mapping isn't there yet, that handler treats our own
			// placeholder as a user-created file and POSTs it to the server
			// → 409 path-conflict.
			await this.hooks.addFileMapping(fullPath, { orgId: org.id, fileId: file.id });
			if (!this.vault.getAbstractFileByPath(fullPath)) {
				try { await this.vault.create(fullPath, ""); }
				catch (e) { if (!isAlreadyExists(e)) throw e; }
			}
		}

		// Deletions: any mapping pointing at this org whose path isn't on the
		// server tree anymore should be removed from both mapping and vault.
		for (const [path, mapping] of Object.entries(this.hooks.getKnownFiles())) {
			if (mapping.orgId !== org.id) continue;
			if (serverPaths.has(path)) continue;
			if (!path.startsWith(orgFolder + "/")) continue;
			try { await this.vault.delete(path); }
			catch (e) { /* file may already be gone */ }
			await this.hooks.removeFileMapping(path);
		}
	}

	private async ensureParents(fullPath: string): Promise<void> {
		const parts = fullPath.split("/");
		parts.pop();
		let acc = "";
		for (const p of parts) {
			acc = acc ? `${acc}/${p}` : p;
			if (this.vault.getAbstractFileByPath(acc)) continue;
			try { await this.vault.createFolder(acc); }
			catch (e) { if (!isAlreadyExists(e)) throw e; }
		}
	}
}

function isAlreadyExists(e: unknown): boolean {
	const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
	return msg.includes("already exists");
}
