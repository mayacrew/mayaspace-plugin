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
	/**
	 * 트리 동기화(syncTrees)가 진행 중이거나 직후인지. true면 이번 틱의 삭제 판정을 건너뛴다.
	 * 동기화는 공유 매핑을 대량 갱신하는 중이라, 폴러가 그 도중 스냅샷과 다른 시점의 트리를
	 * 비교하면 서버에 멀쩡히 있는 파일을 손실로 오판한다(벌크 수신측 onFileLost 폭주의 한 축).
	 */
	isSyncing?(): boolean;
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
			serverPaths.add(fullPath.normalize("NFC")); // 손실 판정은 NFC로 비교(아래 classifyKnownMappings 참조)
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

		// 삭제 판정은 트리 동기화가 진행 중/직후면 통째로 건너뛴다. 동기화가 공유 매핑을 대량
		// 갱신하는 중엔 폴러가 그 도중 매핑 스냅샷을 다른 시점의 트리와 비교해 멀쩡한 파일을
		// 손실로 오판하기 때문이다(벌크 수신측 onFileLost 폭주). add-loop은 위에서 이미 돌았다.
		if (this.hooks.isSyncing?.()) return;

		// Deletions: known mappings for this org whose path is no longer on the server tree.
		// A MOVED file keeps its fileId at a new path — skip it (move, not loss). The old path
		// drops out of serverPaths but the fileId is still present; treating it as a loss would
		// purgeDoc the still-live doc and race the new path's session. The add-loop above already
		// created the new-path mapping; onMoved (SSE) handles the rename, this only covers the race.
		const { moved, lost, knownInOrg } = classifyKnownMappings(
			this.hooks.getKnownFiles(),
			serverPaths,
			serverFileIds,
			org.id,
			orgFolder,
		);

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

interface KnownMapping {
	orgId: string;
	fileId: string;
}

export interface KnownClassification {
	/** fileId는 트리에 남아 있고 경로만 빠진 것(이동) — 옛 경로만 정리, 손실 아님. */
	moved: Array<[string, KnownMapping]>;
	/** 경로도 fileId도 트리에 없는 것(진짜 회수/삭제). */
	lost: Array<[string, KnownMapping]>;
	/** 이 org 폴더 안의 알려진 매핑 수(대량삭제 가드 분모). */
	knownInOrg: number;
}

/**
 * 알려진 매핑을 서버 트리와 대조해 present/moved/lost로 분류한다(순수).
 *
 * 경로는 **NFC로 정규화**해 비교한다 — macOS는 한글 파일명을 NFD로 다루는데(매핑 키가 NFD),
 * 서버 트리 경로(NFC)와 byte 그대로 비교하면 같은 파일이 손실/이동으로 오판돼 로컬에서 잘못
 * 삭제된다. tree-sync의 `findUnmappedLocalFiles`가 같은 이유로 같은 정규화를 한다.
 * `serverPaths`는 NFC로 정규화된 집합이어야 한다. `serverFileIds`는 UUID(ASCII)라 정규화 불필요.
 */
export function classifyKnownMappings(
	known: Record<string, KnownMapping>,
	serverPaths: Set<string>,
	serverFileIds: Set<string>,
	orgId: string,
	orgFolder: string,
): KnownClassification {
	const moved: Array<[string, KnownMapping]> = [];
	const lost: Array<[string, KnownMapping]> = [];
	let knownInOrg = 0;
	const orgPrefix = `${orgFolder}/`.normalize("NFC");
	for (const [path, mapping] of Object.entries(known)) {
		if (mapping.orgId !== orgId) continue;
		const nfc = path.normalize("NFC");
		if (!nfc.startsWith(orgPrefix)) continue;
		knownInOrg++;
		if (serverPaths.has(nfc)) continue;
		(serverFileIds.has(mapping.fileId) ? moved : lost).push([path, mapping]);
	}
	return { moved, lost, knownInOrg };
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
