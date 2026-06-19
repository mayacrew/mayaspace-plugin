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
	delete(file: unknown): Promise<void>;
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
	/** 파일별 effective_permissions 전달. 캐시 갱신용. */
	onFilePermissions?(fileId: string, perms: number): void;
	/** 권한 회수/서버 삭제로 로컬 파일을 지우기 직전 호출. prefetch 중단·detach·Notice용. */
	onFileLost?(path: string, mapping: { orgId: string; fileId: string }): void;
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
		const serverFileIds = new Set<string>();
		for (const file of tree) {
			const fullPath = `${orgFolder}/${file.path}`;
			serverPaths.add(fullPath);
			serverFileIds.add(file.id);
			this.hooks.onFilePermissions?.(file.id, file.effective_permissions ?? 0);
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

		// Deletions: known mappings for this org whose path is no longer on the server tree.
		// A MOVED file keeps its fileId at a new path — skip it (move, not loss). The old path
		// drops out of serverPaths but the fileId is still present; treating it as a loss would
		// purgeDoc the still-live doc and race the new path's session. The add-loop above already
		// created the new-path mapping; onMoved (SSE) handles the rename, this only covers the race.
		const known = this.hooks.getKnownFiles();
		const moved: Array<[string, { orgId: string; fileId: string }]> = [];
		const lost: Array<[string, { orgId: string; fileId: string }]> = [];
		let knownInOrg = 0;
		for (const [path, mapping] of Object.entries(known)) {
			if (mapping.orgId !== org.id) continue;
			if (!path.startsWith(orgFolder + "/")) continue;
			knownInOrg++;
			if (serverPaths.has(path)) continue;
			// fileId가 트리에 여전히 있으면 이동(손실 아님): 옛 경로만 정리, onFileLost는 부르지 않는다
			// (still-live doc purge는 새 경로 세션을 죽이고 IndexedDB 영속화와 레이스).
			(serverFileIds.has(mapping.fileId) ? moved : lost).push([path, mapping]);
		}

		// 이동: 옛 경로 정리. 매핑을 먼저 지운 뒤 vault.delete(서버 DELETE 전파 방지). onFileLost 없음.
		for (const [path] of moved) {
			await this.hooks.removeFileMapping(path);
			const file = this.vault.getAbstractFileByPath(path);
			if (file) { try { await this.vault.delete(file); } catch (e) { /* already gone */ } }
		}

		// 데이터 보호: 진짜 손실이 한 틱에 대량이면 거의 항상 서버 응답 열화(벌크 부하 중 빈/부분 트리)다.
		// 진짜 회수는 SSE로 즉시 처리되므로 폴이 잡는 손실은 보통 0~소수. 임계 초과면 이번 틱 삭제를
		// 건너뛴다(서버가 원본이라 다음 정상 트리에서 맞춰짐).
		if (shouldSkipMassDeletion(lost.length, knownInOrg)) {
			this.hooks.onError?.(
				new Error(`[tree-poller] org ${org.id}: ${lost.length}/${knownInOrg} 손실 후보 — 응답 열화로 보고 이번 틱 삭제를 건너뜀`),
			);
			return;
		}

		for (const [path, mapping] of lost) {
			this.hooks.onFileLost?.(path, mapping);
			// Remove the mapping BEFORE vault.delete (서버 DELETE 전파 방지 — 위 이동 정리와 동일 이유).
			await this.hooks.removeFileMapping(path);
			const file = this.vault.getAbstractFileByPath(path);
			if (file) { try { await this.vault.delete(file); } catch (e) { /* already gone */ } }
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

// 폴 1회에 이만큼(절대치) 이상이고 동시에 org 알려진 파일의 이 비율 이상이 삭제 후보면 "대량"으로 본다.
export const TREE_POLL_MASS_DELETE_MIN = 10;
export const TREE_POLL_MASS_DELETE_RATIO = 0.5;

/**
 * 이번 폴 틱의 로컬 삭제를 건너뛸지. 손실 후보가 절대치와 비율을 동시에 넘으면(=대량) true.
 * 빈/부분 트리로 다수가 한꺼번에 사라지는 건 거의 항상 응답 열화다 — 이때 지우지 않는 게 안전하다.
 * 소수 삭제(단일 파일 등)는 정당한 경우가 많아 통과시킨다. 진짜 대량 회수는 SSE/명시적 Sync가 처리.
 */
export function shouldSkipMassDeletion(toDelete: number, knownInOrg: number): boolean {
	if (toDelete === 0) return false;
	return toDelete >= TREE_POLL_MASS_DELETE_MIN && toDelete >= knownInOrg * TREE_POLL_MASS_DELETE_RATIO;
}
