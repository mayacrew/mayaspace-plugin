/**
 * MayaSpace Obsidian plugin — entry point.
 *
 * Wires together: OAuth Device Flow login, REST client, Hocuspocus provider,
 * per-file Y.Doc binding to CodeMirror, vault ↔ server tree sync, SSE event
 * subscription, and the file-explorer decorator.
 *
 * Responsibilities live in modules under src/{auth,api,sync,vault,events,ui};
 * this file is glue.
 */

import { Editor, MarkdownView, Notice, Plugin, TFile, TFolder, requestUrl } from "obsidian";

import {
	MayaspaceSettings,
	DEFAULT_SETTINGS,
	MayaspaceSettingTab,
} from "./settings";

import { MayaspaceAuth, type TokenSet } from "./auth/mayaspace-auth";
import { PluginTokenStorage } from "./auth/token-storage";
import { DeviceFlowModal } from "./auth/device-flow-modal";
import { ConfirmModal } from "./auth/confirm-modal";

import { makeObsidianFetcher, type Fetcher } from "./api/mayaspace-http";
import { MayaspaceApi, EtagMismatchError, type FileMeta } from "./api/mayaspace-api";
import { httpStatusOf, isPathConflict, isTransientHttp } from "./api/http-errors";

import { MayaspaceSync, defaultHocuspocusFactory } from "./sync/mayaspace-sync";
import { LiveCollabSession } from "./sync/live-collab-session";
import { bindYCollab } from "./sync/yCollab-binder";
import { shouldApplyPrefetch } from "./sync/prefetch-policy";
import { debounce } from "./lib/debounce";
import { mergeDiskIntoYtext } from "./lib/merge-disk-into-ytext";

import { syncOrgTrees, findUnmappedLocalFiles, findUnmappedFilesUnderFolder, ensureFile, ensureParentFolders, type FileMapping, type SyncResult, type VaultLike } from "./vault/tree-sync";
import { UploadQueue } from "./vault/upload-queue";
import { createSaveScheduler, type SaveScheduler } from "./lib/save-scheduler";
import { FileMappings } from "./vault/file-mappings";
import { TreePoller, type PollerVault } from "./vault/tree-poller";

import { MayaspaceEvents } from "./events/sse-subscriber";

import { makePeerIdentity } from "./ui/peer-identity";
import { ExplorerDecorator, type SyncStatus, type ContentState } from "./ui/explorer-decorator";
import { CollabSidebarView, VIEW_TYPE_COLLAB, type CollabSidebarCallbacks } from "./ui/collab-sidebar";
import { TrashModal } from "./ui/trash-modal";
import { ShareCreateModal, ShareManageModal } from "./ui/share-modal";

import { parseMayaspacePath, sanitizeFolderName, canonicalServerPath } from "./lib/path";
import { inheritedPermsForPath } from "./lib/path-perms";
import { READ, UPDATE, CREATE, DELETE, can } from "./lib/permissions";
import { isImagePath, bytesToBase64, MAX_IMAGE_BYTES, makeRand4, decideImageDrop } from "./lib/attachments";
import { checkCreate, checkUpdate, checkDelete, checkMove } from "./permissions/permission-guard";
import { EditorView } from "@codemirror/view";

// Minimal structural view of a Y.Doc holding the "content" Y.Text. The real
// yjs types live behind the provider handle (`any`); this keeps the modify
// merge path typed without dragging the full yjs surface in.
type YText = { toString(): string; delete(index: number, length: number): void; insert(index: number, text: string): void };
type YDocWithText = { transact(fn: () => void): void; getText(name: string): YText };

export default class MayaspacePlugin extends Plugin {
	settings!: MayaspaceSettings;
	auth!: MayaspaceAuth;
	api!: MayaspaceApi;
	sync!: MayaspaceSync;
	liveCollab!: LiveCollabSession;
	// HTTP transport, rebuilt with the other clients on URL change. Used for the
	// SSE ticket POST, which lives outside MayaspaceApi (auth-owned surface).
	private fetcher!: Fetcher;
	mappings!: FileMappings;
	decorator!: ExplorerDecorator;
	// 폴더 드랍·reconcile 등 벌크 업로드(로컬→서버)를 동시성 제한·재시도로 흘려보내는 전역 큐.
	private uploadQueue!: UploadQueue;
	// SSE로 받은 파일의 본문 hydrate(서버→로컬, REST read)를 동시성 제한으로 흘려보내는 큐.
	// 다른 기기가 100개를 벌크 생성/수정하면 받는 쪽도 REST read가 폭주하므로 묶는다.
	private hydrateQueue!: UploadQueue;
	// 같은 org 안의 파일 이동(rename)을 동시성 제한으로 흘려보내는 큐. 폴더째 100개 이동 시
	// moveFile burst를 막는다. newPath를 키로 pendingMoves에서 상세를 조회한다.
	private moveQueue!: UploadQueue;
	// 로컬 삭제(서버 DELETE 전파)를 동시성 제한·재시도로 흘려보내는 큐. 폴더째 1000개 삭제 시
	// deleteFile burst가 서버 풀을 고갈시키고(타임아웃 → 실패) 메인 스레드를 막는 것을 방지한다.
	private deleteQueue!: UploadQueue;
	// 잦은 매핑 변경을 1회 디스크 쓰기로 합치는 저장 스케줄러(대량 삭제 시 O(N²) saveSettings 방지).
	private saveScheduler!: SaveScheduler;
	private readonly pendingMoves = new Map<string, { oldPath: string; orgId: string; fileId: string; newRelPath: string }>();
	// cross-org로 옮겨져 차단된 새 경로(세션 한정). handleVaultCreate가 이 경로의 업로드를 막는다.
	private readonly crossOrgBlocked = new Set<string>();
	// cross-org 이동 안내 — 폴더째 이동 시 파일마다 안 뜨고 한 번만 뜨게 디바운스.
	private readonly warnCrossOrgMove = debounce(() => {
		new Notice("MayaSpace: 다른 조직(org)으로의 이동은 지원하지 않습니다. 같은 조직 안에서만 이동하세요.");
	}, 500);

	private events: MayaspaceEvents | null = null;
	private collabSidebar: CollabSidebarView | null = null;
	private treePoller: TreePoller | null = null;
	// 동시 syncTrees 실행 방지 플래그.
	private syncingTrees = false;
	// 마지막 tree.changed(벌크 coalesce) 수신 시각 — 폴러 삭제 보류 창 계산용.
	private lastTreeChangeAt = 0;
	// 서버 access.changed 신호 → 권한 즉시 재동기화. 짧게 몰아쳐도 한 번만 돌도록 디바운스.
	private readonly resyncOnAccessChange = debounce(() => {
		void this.syncTrees().catch((e) => console.warn("[mayaspace] access.changed resync", e));
	}, 800);
	// 서버 tree.changed 신호(I1 burst coalesce) → 트리 재동기화. 디바운스로 묶는다.
	private readonly resyncOnTreeChange = debounce(() => {
		void this.syncTrees().catch((e) => console.warn("[mayaspace] tree.changed resync", e));
	}, 800);
	private statusBarItem: HTMLElement | null = null;
	// 벌크 업로드 진행률 전용 아이템. 계정 상태바(saveSettings가 갱신)와 분리해 충돌을 막는다.
	private uploadStatusItem: HTMLElement | null = null;
	private fileStatuses: Record<string, SyncStatus> = {};
	// 본문 hydrate 진행 중인 경로(배지 hydrating 표시용).
	private readonly hydratingPaths = new Set<string>();
	// 대형 vault background drip 타이머(없으면 null).
	private hydrateDripTimer: number | null = null;
	// 이번 drip 사이클에서 이미 hydrate를 시도한 경로. 본문이 빈 파일은 hydrate해도 placeholder를
	// 못 벗어나는데(size 0), 커서가 "남은 첫 placeholder"라 같은 빈 파일에서 무한 제자리(livelock)
	// 했다. 시도한 건 건너뛰어 다음으로 진행한다. 새 사이클마다 비운다(빈 파일이 나중에 본문을 받으면 재시도).
	private readonly dripAttempted = new Set<string>();
	private settingTab: MayaspaceSettingTab | null = null;
	private prefetches = new Map<string, () => void>();
	// Most-recently-opened mapped paths, newest last. Bounds the live prefetch
	// scope so a large vault doesn't open a session per file (see #6 / the
	// prefetchAllFiles setting).
	private recentlyOpened: string[] = [];
	// path → hash of the content we last wrote via safeModify. handleVaultModify
	// compares the modified file's content hash against this: a match means the
	// event is the echo of our own write and is ignored; a mismatch is a real
	// external edit and is propagated. A content hash (vs the old 1.5s timer)
	// won't swallow an external edit that lands within the self-write window.
	private selfWriteHashes = new Map<string, string>();
	// Paths whose POST /files is currently in flight. The raw fs.watch under
	// Obsidian fires vault.on('create') more than once for a single CLI
	// write (and Obsidian's own index update can fire it again), so without
	// this guard we'd race two creates → second one hits the (orgId,path)
	// unique constraint on the server and surfaces a 500.
	private inflightCreates = new Set<string>();

	// 폴더 드랍 스캔이 진행 중인 폴더 경로(같은 폴더 중복 스캔 방지).
	private readonly folderCreateScans = new Set<string>();
	// Debounce timer for file-open → live-collab (re)binding. See file-open
	// handler: coalesces rapid in-leaf file switching so it binds once settled.
	private fileOpenTimer: ReturnType<typeof setTimeout> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.buildMappings();
		this.rebuildBackendClients();
		this.buildLiveCollab();
		this.buildDecorator();
		this.buildQueues();

		this.buildCollabSidebar();

		this.settingTab = new MayaspaceSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.registerCommands();

		this.statusBarItem = this.addStatusBarItem();
		this.uploadStatusItem = this.addStatusBarItem();
		this.renderStatusBar();

		this.registerVaultHandlers();
		this.registerWorkspaceHandlers();

		this.app.workspace.onLayoutReady(async () => {
			this.decorator.refresh();
			if (this.settings.tokenSet) {
				await this.syncTrees().catch((e) => console.warn("[mayaspace] initial sync", e));
				this.startEventsSubscription();
				this.restartTreePoller();
			}
			// Obsidian restores the previously open file but does NOT re-fire
			// 'file-open' for it. When the plugin is enabled with a file
			// already in the editor (Obsidian start, disable/enable toggle),
			// our attach would never run. Pick up the currently active
			// MarkdownView here as a one-shot bootstrap.
			this.attachCurrentActiveFile();
		});
	}

	private attachCurrentActiveFile(): void {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!active || !active.file) return;
		const path = active.file.path;
		const mapping = this.mappings.getFile(path);
		if (!mapping) {
			console.log("[mayaspace] attachCurrentActiveFile: no mapping yet for", path);
			return;
		}
		console.log("[mayaspace] attachCurrentActiveFile →", path);
		setTimeout(async () => {
			for (const other of this.liveCollab.activePaths()) {
				if (other === path) continue;
				await this.liveCollab.detach(other).catch(() => undefined);
				delete this.fileStatuses[other];
			}
			const permsActive = this.permsForFileId(mapping.orgId, mapping.fileId);
			if (!can(permsActive, READ)) {
				console.log("[mayaspace] skip live-collab attach: no READ perm", path);
				return;
			}
			const readOnly = !can(permsActive, UPDATE);
			await this.liveCollab.attach(path, mapping, { readOnly }).catch((e) =>
				console.warn("[mayaspace] attach on layout-ready failed", path, e),
			);
		}, 0);
	}

	async onunload(): Promise<void> {
		await this.saveScheduler?.flush(); // 디바운스 대기 중인 매핑 변경을 잃지 않게 먼저 비운다
		this.treePoller?.stop();
		if (this.fileOpenTimer) clearTimeout(this.fileOpenTimer);
		this.events?.unsubscribeAll();
		this.stopBackgroundHydrate();
		this.stopAllPrefetches();
		await this.liveCollab.detachAll();
		await this.sync.closeAll();
		this.decorator.clear();
	}

	// ---------- Settings ----------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<MayaspaceSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.renderStatusBar();
	}

	// ---------- Wiring ----------

	private buildMappings(): void {
		this.mappings = new FileMappings({
			getFiles: () => this.settings.fileMappings,
			setFiles: async (f) => { this.settings.fileMappings = f; await this.saveSettings(); },
			getOrgs: () => this.settings.orgMappings,
			setOrgs: async (o) => { this.settings.orgMappings = o; await this.saveSettings(); },
		});
		this.mappings.onChange(() => this.decorator?.refresh());
	}

	rebuildBackendClients(): void {
		const tokenStorage = new PluginTokenStorage({
			getTokenSet: () => this.settings.tokenSet,
			setTokenSet: async (t) => {
				this.settings.tokenSet = t;
				if (!t) this.settings.accountEmail = null;
				await this.saveSettings();
			},
		});
		const fetcher = makeObsidianFetcher(requestUrl as any);
		this.fetcher = fetcher;
		this.auth = new MayaspaceAuth(this.settings.serverUrl, fetcher, tokenStorage);
		this.api = new MayaspaceApi(this.settings.serverUrl, this.auth, fetcher);
		this.sync = new MayaspaceSync(this.settings.wsUrl, this.auth, defaultHocuspocusFactory());

		this.sync.onPermissionLost(({ orgId, fileId }) => {
			const path = this.liveCollab?.pathFor(orgId, fileId);
			if (path) {
				this.liveCollab.detach(path).catch(() => undefined);
				new Notice(`MayaSpace: access to "${path}" was revoked.`);
			}
		});
		this.sync.onStatus(({ orgId, fileId, status }) => {
			const path = this.liveCollab?.pathFor(orgId, fileId);
			if (!path) return;
			const display: SyncStatus =
				status === "connected" ? "connected" :
				status === "connecting" ? "syncing" : "offline";
			this.fileStatuses[path] = display;
			this.decorator?.updateStatus(path, display);
			// 협업 연결로 본문이 디스크에 채워지므로 content 배지도 함께 갱신한다.
			this.decorator?.updateContent(path, this.contentStateFor(path));
		});
	}

	/**
	 * Tear down everything bound to the current server before swapping clients,
	 * then rebuild and re-subscribe. Called when the REST/WS URL changes in
	 * settings. Order matters: stop inbound streams and per-file sessions FIRST
	 * (each prefetch cleanup closes on the sync it opened with), detach live
	 * collaboration, close the OLD sync, then recreate clients + live session.
	 * Without this, stale SSE/providers keep talking to the previous server and
	 * could send its token there.
	 */
	async restartBackend(): Promise<void> {
		this.events?.unsubscribeAll();
		this.events = null;
		this.treePoller?.stop();
		this.treePoller = null;
		this.stopBackgroundHydrate();
		this.stopAllPrefetches();
		await this.liveCollab.detachAll();
		await this.sync.closeAll();

		this.rebuildBackendClients();
		this.buildLiveCollab();

		if (!this.settings.tokenSet) return;
		await this.syncTrees().catch((e) => console.warn("[mayaspace] restartBackend sync", e));
		this.startEventsSubscription();
		this.restartTreePoller();
	}

	private buildLiveCollab(): void {
		this.liveCollab = new LiveCollabSession({
			api: this.api,
			sync: this.sync,
			bindEditor: (view, handle, readOnly) => {
				const identity = makePeerIdentity(this.settings.displayName || null, this.settings.accountEmail);
				return bindYCollab(view as EditorView, handle, identity, { readOnly: !!readOnly });
			},
			findEditorView: (path) => this.findEditorViewForPath(path),
			dumpContent: async (path, content) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					try { await this.safeModify(file, content); }
					catch (e) { console.warn("[mayaspace] vault.modify on dump failed", path, e); }
				}
			},
		});
	}

	private buildDecorator(): void {
		this.decorator = new ExplorerDecorator(this.app, {
			getOrgFilePaths: () => Object.keys(this.settings.fileMappings),
			getStatuses: () => this.fileStatuses,
			getContentStates: () => this.computeContentStates(),
		});
	}

	private buildQueues(): void {
		this.saveScheduler = createSaveScheduler(() => this.saveSettings(), SAVE_DEBOUNCE_MS);

		this.uploadQueue = new UploadQueue({
			concurrency: UPLOAD_CONCURRENCY,
			maxAttempts: UPLOAD_MAX_ATTEMPTS,
			backoffMs: (attempt) => Math.min(UPLOAD_BACKOFF_BASE_MS * 2 ** (attempt - 1), UPLOAD_BACKOFF_MAX_MS),
			// bulk: prefetch/hydrate/Notice를 건너뛰고, 일시적 실패는 큐가 재시도하도록 위로 던진다.
			upload: (path) => this.handleVaultCreate(path, { bulk: true }),
			isTransient: isTransientHttp,
			sleep,
			log: (m) => console.log("[mayaspace][upload]", m),
			onProgress: (done, total) => this.renderUploadProgress(done, total),
			onSettled: (summary) => {
				this.uploadStatusItem?.setText("");
				if (summary.failed > 0) {
					new Notice(`MayaSpace: ${summary.failed}개 업로드 실패 — 'Sync now'로 다시 시도하세요.`);
				}
			},
		});

		this.hydrateQueue = new UploadQueue({
			concurrency: HYDRATE_CONCURRENCY,
			maxAttempts: 1, // hydrateFile이 자체적으로 에러를 삼킨다 — 재시도 없이 동시성만 제한.
			backoffMs: () => 0,
			upload: (path) => {
				const mapping = this.settings.fileMappings[path];
				return mapping ? this.hydrateFile(path, mapping) : Promise.resolve();
			},
			isTransient: () => false,
			sleep,
			log: (m) => console.log("[mayaspace][hydrate]", m),
		});

		this.moveQueue = new UploadQueue({
			concurrency: UPLOAD_CONCURRENCY,
			maxAttempts: UPLOAD_MAX_ATTEMPTS,
			backoffMs: (attempt) => Math.min(UPLOAD_BACKOFF_BASE_MS * 2 ** (attempt - 1), UPLOAD_BACKOFF_MAX_MS),
			upload: (newPath) => this.runQueuedMove(newPath),
			isTransient: isTransientHttp,
			sleep,
			log: (m) => console.log("[mayaspace][move]", m),
			onProgress: (done, total) => this.uploadStatusItem?.setText(done < total ? `MayaSpace: 이동 ${done}/${total}` : ""),
			onSettled: (s) => {
				this.uploadStatusItem?.setText("");
				if (s.failed > 0) new Notice(`MayaSpace: ${s.failed}개 이동 실패 — 다시 시도하세요.`);
			},
		});

		this.deleteQueue = new UploadQueue({
			concurrency: UPLOAD_CONCURRENCY,
			maxAttempts: UPLOAD_MAX_ATTEMPTS,
			backoffMs: (attempt) => Math.min(UPLOAD_BACKOFF_BASE_MS * 2 ** (attempt - 1), UPLOAD_BACKOFF_MAX_MS),
			upload: (path) => this.handleVaultDelete(path),
			isTransient: isTransientHttp,
			sleep,
			log: (m) => console.log("[mayaspace][delete]", m),
			onProgress: (done, total) => this.uploadStatusItem?.setText(done < total ? `MayaSpace: 삭제 ${done}/${total}` : ""),
			onSettled: (s) => {
				this.uploadStatusItem?.setText("");
				if (s.failed > 0) new Notice(`MayaSpace: ${s.failed}개 삭제 실패 — 'Sync now'로 다시 시도하세요.`);
			},
		});
	}

	private renderUploadProgress(done: number, total: number): void {
		this.uploadStatusItem?.setText(done < total ? `MayaSpace: 업로드 ${done}/${total}` : "");
	}

	private buildCollabSidebar(): void {
		const callbacks: CollabSidebarCallbacks = {
			getAccessSummary: async (orgId, fileId) => {
				const result = await this.api.getFileAccessSummary(orgId, fileId);
				return result.members;
			},
			getHistory: async (orgId, fileId) => {
				const result = await this.api.getFileHistory(orgId, fileId);
				return result.entries;
			},
			getPresence: async (orgId, fileId) => {
				const result = await this.api.getFilePresence(orgId, fileId);
				return result.userIds;
			},
			getMyEmail: () => this.settings.accountEmail,
			listVersions: (orgId, fileId) => this.api.listVersions(orgId, fileId),
			getVersion: (orgId, fileId, versionId) => this.api.getVersion(orgId, fileId, versionId),
			createVersion: (orgId, fileId, label) => this.api.createVersion(orgId, fileId, label),
			restoreVersion: (orgId, fileId, versionId) => this.api.restoreVersion(orgId, fileId, versionId),
			deleteVersion: (orgId, fileId, versionId) => this.api.deleteVersion(orgId, fileId, versionId),
			onRestored: (orgId, fileId, filePath) => {
				void this.rehydrateAfterRestore(orgId, fileId, filePath);
			},
			openShare: (orgId, fileId, filePath) => {
				new ShareCreateModal(this.app, this.api, orgId, fileId, filePath).open();
			},
			openManageShares: (orgId, fileId) => {
				new ShareManageModal(this.app, this.api, orgId, fileId).open();
			},
			openTrash: () => this.openTrashModal(),
		};

		this.registerView(VIEW_TYPE_COLLAB, (leaf) => {
			this.collabSidebar = new CollabSidebarView(leaf, callbacks);
			return this.collabSidebar;
		});

		this.addRibbonIcon("users", "MayaSpace 협업 사이드바", () => this.activateCollabSidebar());
	}

	private async activateCollabSidebar(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_COLLAB);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_COLLAB, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	/** 사이드바에 현재 파일 컨텍스트를 업데이트한다. main.ts의 file-open 핸들러가 호출. */
	private updateSidebarContext(filePath: string | null): void {
		if (!this.collabSidebar) return;
		if (!filePath) {
			this.collabSidebar.setFileContext(null);
			return;
		}
		const mapping = this.mappings.getFile(filePath);
		if (!mapping) {
			this.collabSidebar.setFileContext(null);
			return;
		}
		this.collabSidebar.setFileContext({ orgId: mapping.orgId, fileId: mapping.fileId, filePath });
	}

	// ---------- Commands ----------

	private registerCommands(): void {
		this.addCommand({
			id: "connect",
			name: "MayaSpace: Sign in",
			callback: () => this.startConnect(),
		});
		this.addCommand({
			id: "logout",
			name: "MayaSpace: Sign out",
			callback: () => this.doLogout(),
		});
		this.addCommand({
			id: "signup",
			name: "MayaSpace: 회원가입",
			callback: () => this.startSignup(),
		});
		this.addCommand({
			id: "sync-trees",
			name: "MayaSpace: Sync org trees",
			callback: () => this.syncTrees().catch((e) => new Notice(`Sync failed: ${describe(e)}`)),
		});
		this.addCommand({
			id: "open-admin",
			name: "MayaSpace: Open web dashboard",
			callback: () => {
				const base = this.settings.webAppUrl.replace(/\/+$/, "");
				if (!base) { new Notice("Set Web app URL first."); return; }
				window.open(`${base}/dashboard`, "_blank");
			},
		});
		this.addCommand({
			id: "smoke-capabilities",
			name: "MayaSpace: Check server capabilities",
			callback: () => this.smokeCheckCapabilities(),
		});
		this.addCommand({
			id: "restore-deleted",
			name: "MayaSpace: 삭제된 파일 복구",
			callback: () => this.openTrashModal(),
		});
		this.addCommand({
			id: "share-link",
			name: "MayaSpace: 링크로 공유",
			callback: () => {
				if (!this.settings.tokenSet) { new Notice("먼저 로그인하세요."); return; }
				const m = this.activeNoteMapping();
				if (!m) { new Notice("동기화된 노트에서 실행하세요."); return; }
				new ShareCreateModal(this.app, this.api, m.orgId, m.fileId, m.path).open();
			},
		});
		this.addCommand({
			id: "manage-shares",
			name: "MayaSpace: 공유 관리",
			callback: () => {
				if (!this.settings.tokenSet) { new Notice("먼저 로그인하세요."); return; }
				const m = this.activeNoteMapping();
				if (!m) { new Notice("동기화된 노트에서 실행하세요."); return; }
				new ShareManageModal(this.app, this.api, m.orgId, m.fileId).open();
			},
		});
	}

	/** 삭제된 파일 복구 모달 — 명령·사이드바 버튼 양쪽에서 호출. */
	private openTrashModal(): void {
		if (!this.settings.tokenSet) { new Notice("먼저 로그인하세요."); return; }
		const orgs = Object.entries(this.settings.orgMappings).map(([folder, orgId]) => ({ folder, orgId }));
		if (orgs.length === 0) { new Notice("동기화된 조직이 없습니다."); return; }
		new TrashModal(this.app, this.api, orgs, () => void this.syncTrees().catch(() => {})).open();
	}

	/** 활성 마크다운 노트의 org/fileId 매핑(미동기화면 null). */
	private activeNoteMapping(): { orgId: string; fileId: string; path: string } | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!active?.file) return null;
		const m = this.settings.fileMappings[active.file.path];
		return m ? { orgId: m.orgId, fileId: m.fileId, path: active.file.path } : null;
	}

	// ---------- Workspace / Vault handlers ----------

	private registerWorkspaceHandlers(): void {
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file) return;
				const mapping = file ? this.mappings.getFile(file.path) : null;
				// 사이드바 컨텍스트는 즉시 갱신 — liveCollab attach보다 먼저.
				this.updateSidebarContext(file.path);
				// Opening a mapped file brings it into the live prefetch scope:
				// start a background session so its remote edits stream in even
				// when full-vault prefetch is off, and evict the oldest beyond
				// the limit so the scope stays bounded.
				if (mapping) this.noteRecentlyOpened(file.path, mapping);
				// Debounce the (re)binding. With one leaf and fast file switching,
				// binding on every file-open thrashes detach/attach and races
				// Obsidian's EditorState replacement (it replaces the leaf's state
				// on in-leaf switches), leaving the yCollab binding desynced from
				// ytext. Coalesce rapid switches and bind once the user settles.
				// The delay also clears Obsidian's state replacement (a later task).
				if (this.fileOpenTimer) clearTimeout(this.fileOpenTimer);
				this.fileOpenTimer = setTimeout(() => {
					this.fileOpenTimer = null;
					void this.rebindActiveFile(file.path, mapping ?? null);
				}, FILE_OPEN_DEBOUNCE_MS);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.liveCollab.ensureBoundForAllActive();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.liveCollab.ensureBoundForAllActive();
				this.decorator.refresh();
			}),
		);

		// 탐색기 우클릭 → 공유. 로그인·동기화(매핑)된 노트에서만 항목을 띄운다.
		// read/edit별 권한 검증은 서버(create)에 맡기므로 여기서 UPDATE로 막지 않는다.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !this.settings.tokenSet) return;
				const mapping = this.mappings.getFile(file.path);
				if (!mapping) return;
				const { orgId, fileId } = mapping;
				menu.addItem((item) =>
					item
						.setTitle("MayaSpace: 링크로 공유")
						.setIcon("share-2")
						.onClick(() => new ShareCreateModal(this.app, this.api, orgId, fileId, file.basename).open()),
				);
				menu.addItem((item) =>
					item
						.setTitle("MayaSpace: 공유 관리")
						.setIcon("link")
						.onClick(() => new ShareManageModal(this.app, this.api, orgId, fileId).open()),
				);
			}),
		);
	}

	// NOTE: we deliberately do NOT eager-detach on every leaf change. Obsidian
	// transiently "closes" leaves during mode switches and split moves; if we
	// killed the Hocuspocus session each time, the user would see sync glitch
	// every time they touch the layout. A live session on a file the user is
	// no longer looking at is cheap (server keeps the same Y.Doc), and the
	// session is torn down properly on logout / unload / vault delete.

	private registerVaultHandlers(): void {
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (f instanceof TFile) {
					// 모든 파일 create를 전역 큐로. 폴더 임포트 시 Obsidian이 안쪽 파일마다 개별
					// create를 쏟아도(100개+) 동시성 상한으로 묶어 서버 풀·WS 폭주를 막는다.
					// 큐가 dedupe·재시도·진행률을 처리하고, bulk 경로라 파일당 prefetch도 안 연다.
					this.uploadQueue.enqueue(f.path);
				} else if (f instanceof TFolder) {
					// 폴더 드랍 시 안쪽 파일 create가 일부 누락되는 경우 대비: 폴더 단위로 스캔해
					// 같은 큐에 넣는다(이미 큐/매핑에 있으면 dedupe·멱등 가드가 막음).
					this.handleFolderCreate(f.path).catch((e) => console.warn("[mayaspace] folder create", e));
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (f instanceof TFile) {
					this.handleVaultRename(oldPath, f.path).catch((e) => console.warn("[mayaspace] rename", e));
				} else if (f instanceof TFolder) {
					// 폴더가 mayaspace "밖"에서 들어온 신규 import일 때만 스캔-업로드한다. vault 안에서의
					// 이동(같은 org=파일별 move 큐, cross-org=차단)은 파일별 rename이 처리하므로 폴더
					// 스캔을 돌리지 않는다 — 안 그러면 이동을 신규 생성으로 오인해 중복 업로드한다.
					if (!parseMayaspacePath(oldPath, this.settings.mayaspaceRoot)) {
						this.handleFolderCreate(f.path).catch((e) => console.warn("[mayaspace] folder import", e));
					}
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (!(f instanceof TFile)) return;
				// 폴더째 삭제 시 Obsidian이 파일마다 개별 delete를 쏟아도(1000개+) 동시성 상한으로
				// 묶어 서버 DELETE 폭주를 막는다(생성 경로의 uploadQueue와 대칭). 매핑 없는 일반
				// 파일은 handleVaultDelete가 어차피 early-return하므로 큐에 넣지 않는다.
				if (!this.settings.fileMappings[f.path]) return;
				this.deleteQueue.enqueue(f.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (!(f instanceof TFile)) return;
				this.handleVaultModify(f.path).catch((e) => console.warn("[mayaspace] modify", e));
			}),
		);
		// 이미지 드롭/붙여넣기: org 폴더 안 노트에서는 vault 루트(Obsidian 기본
		// 동작) 대신 노트 옆 attachments/에 저장해 폴더 ACL을 상속시킨다.
		this.registerEvent(
			this.app.workspace.on("editor-drop", (evt, editor, info) => {
				if (evt.defaultPrevented) return;
				const files = Array.from(evt.dataTransfer?.files ?? []);
				this.handleImageDrop(files, evt, editor, info?.file?.path ?? null);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt, editor, info) => {
				if (evt.defaultPrevented) return;
				const files = Array.from(evt.clipboardData?.files ?? []);
				this.handleImageDrop(files, evt, editor, info?.file?.path ?? null);
			}),
		);
	}

	/**
	 * Wrap vault.modify so we can recognise our own writes inside the
	 * subsequent vault.on('modify') event. Without this guard, every dump
	 * from prefetch / hydrate / detach would round-trip back to the server
	 * as an "external edit" → write loop.
	 *
	 * We record the hash of the content we wrote (not a time window): the
	 * resulting modify event(s) carry exactly this content, so handleVaultModify
	 * matches by hash and ignores them, while an external edit arriving moments
	 * later hashes differently and is still propagated.
	 */
	private async safeModify(file: TFile, content: string): Promise<void> {
		this.selfWriteHashes.set(file.path, hashContent(content));
		await this.app.vault.modify(file, content);
	}

	// ---------- Auth / connect ----------

	private postAuthSuccess = async (): Promise<void> => {
		await this.refreshAccount();
		this.refreshSettingTab();
		await this.syncTrees().catch((e) => new Notice(`Sync failed: ${describe(e)}`));
		this.startEventsSubscription();
		this.restartTreePoller();
	};

	async startConnect(): Promise<void> {
		// Device flow: 플러그인은 비밀번호를 만지지 않는다. 코드 발급 → 브라우저에서 로그인/승인 → 토큰 수령.
		const deviceName = `Obsidian (${navigator.platform || "desktop"})`;
		new DeviceFlowModal(this.app, this.auth, deviceName, this.postAuthSuccess).open();
	}

	async startSignup(): Promise<void> {
		// 가입은 브라우저(고객 웹앱)에서. 가입 후 플러그인에서 "Sign in"으로 device flow 인증한다.
		const base = this.settings.webAppUrl.replace(/\/+$/, "");
		if (!base) { new Notice("먼저 Web app URL을 설정하세요."); return; }
		window.open(`${base}/signup`, "_blank");
		new Notice("브라우저에서 가입한 뒤, 플러그인에서 'Sign in'으로 로그인하세요.");
	}

	doLogout(): void {
		if (!this.settings.tokenSet) {
			new Notice("이미 로그아웃 상태입니다.");
			return;
		}
		new ConfirmModal(
			this.app,
			"MayaSpace 로그아웃",
			"로그아웃하면 동기화와 실시간 협업이 중단됩니다. 계속할까요?",
			"로그아웃",
			() => { this.performLogout().catch((e) => new Notice(`로그아웃 실패: ${describe(e)}`)); },
		).open();
	}

	async performLogout(): Promise<void> {
		this.events?.unsubscribeAll();
		this.events = null;
		this.treePoller?.stop();
		this.treePoller = null;
		this.stopBackgroundHydrate();
		this.stopAllPrefetches();
		await this.liveCollab.detachAll();
		await this.sync.closeAll();
		await this.purgeAllCaches();
		await this.auth.logout();
		this.settings.tokenSet = null;
		this.settings.accountEmail = null;
		await this.saveSettings();
		this.refreshSettingTab();
		new Notice("MayaSpace에서 로그아웃했습니다.");
	}

	/**
	 * Re-render the settings tab if it is currently mounted. Obsidian only
	 * calls display() when the tab is first opened, so the Account section
	 * stays on its initial snapshot after sign-in / sign-out unless we ask
	 * for a redraw. containerEl.isShown() is undocumented but stable.
	 */
	private refreshSettingTab(): void {
		if (!this.settingTab) return;
		const container = this.settingTab.containerEl;
		if (!container || !container.isConnected) return;
		this.settingTab.display();
	}

	private async refreshAccount(): Promise<void> {
		try {
			const me = await this.api.me();
			this.settings.accountEmail = me.email ?? null;
			await this.saveSettings();
		} catch (e) {
			console.warn("[mayaspace] /me failed", e);
		}
	}

	// ---------- Tree sync ----------

	async syncTrees(): Promise<void> {
		if (!this.settings.tokenSet) return;
		// 동시 실행 방지: access.changed·startup·로그인·수동 호출이 겹쳐도 한 번만 돈다.
		if (this.syncingTrees) return;
		this.syncingTrees = true;
		try {
			await this.runTreeSync();
		} finally {
			this.syncingTrees = false;
		}
	}

	private async runTreeSync(): Promise<void> {
		const result = await syncOrgTrees(
			this.app.vault as unknown as Parameters<typeof syncOrgTrees>[0],
			this.api,
			{
				mayaspaceRoot: this.settings.mayaspaceRoot,
				onFileMapped: (path, mapping) => {
					// Synchronous so the vault.on('create') handler below already sees
					// the mapping when our placeholder fires.
					this.settings.fileMappings[path] = mapping;
				},
				onOrgMapped: (folderName, orgId) => {
					this.settings.orgMappings[folderName] = orgId;
				},
				onOrgPermissions: (perms) => this.applyOrgPermissions(perms),
				onFilePermissions: (fileId, perms) => this.applyFilePermission(fileId, perms),
			},
		);
		this.settings.orgMappings = result.orgs;
		this.settings.fileMappings = result.files;
		await this.saveSettings();
		// 누락된 create 이벤트로 매핑 없이 남은 org 폴더 내 로컬 파일을 서버로 업로드(자가복구).
		await this.reconcileLocalOrphans(result);
		this.decorator.refresh();
		// Eager content cache: pull each file's body into the vault so Obsidian
		// search / graph / backlinks work without opening the file. Skip files
		// that already have a live Hocuspocus session (ytext is the truth).
		await this.hydrateAllPlaceholders();
		// Real-time prefetch: open a background Hocuspocus session per file
		// so remote edits stream into vault.md immediately, not only after
		// the server's storeDocument debounce.
		await this.startPrefetchAll();
	}

	/**
	 * org 폴더 안에 있는데 매핑(=서버)에 없는 로컬 파일을 서버로 업로드한다.
	 * create 이벤트가 누락돼(생성 burst·플러그인 리로드) 고아가 된 파일을 자가복구한다.
	 * 마크다운+첨부 모두 대상(getFiles). 권한 없는 파일은 조용히 건너뛴다(폴링마다 Notice 방지).
	 */
	private async reconcileLocalOrphans(synced: SyncResult): Promise<void> {
		const localFiles = this.app.vault.getFiles().map((f) => f.path);
		const orphans = findUnmappedLocalFiles(
			localFiles,
			Object.keys(synced.files),
			this.settings.mayaspaceRoot,
			Object.keys(synced.orgs),
		);

		if (orphans.length === 0) return;
		// 전역 업로드 큐로(bulk) — 동시성 제한 + 재시도. 권한 없는 파일은 handleVaultCreate가 조용히 스킵.
		console.log(`[mayaspace] reconcile: queueing ${orphans.length} orphaned local file(s)`);
		this.uploadQueue.enqueueAll(orphans);
	}

	/**
	 * 폴더를 외부(Finder/Explorer)에서 드래그앤드랍하거나 공유 폴더 안으로 이동하면 Obsidian이
	 * 폴더 이벤트만 안정적으로 쏘고 안쪽 파일 create는 누락되기 쉽다. 게다가 인덱싱이 1.2초보다
	 * 늦을 수 있어 한 번만 스캔하면 늦게 들어온 파일(특히 큰 첨부)을 놓친다. 그래서 점증 간격으로
	 * 몇 번 재스캔하며 그때그때 매핑 안 된 하위 파일(마크다운+첨부)을 전역 업로드 큐(bulk)로 흘려보낸다.
	 * 중복은 handleVaultCreate의 매핑/inflight/409 가드 + 큐 dedupe가 막으므로 재스캔·개별 create가
	 * 겹쳐도 멱등하다. 동시성은 큐가 제한해 연결 폭주를 막는다.
	 */
	private async handleFolderCreate(folderPath: string): Promise<void> {
		if (this.folderCreateScans.has(folderPath)) return;
		this.folderCreateScans.add(folderPath);
		try {
			console.log("[mayaspace] folder create/rename event:", folderPath);
			for (const delay of FOLDER_RESCAN_DELAYS_MS) {
				await sleep(delay);
				const all = this.app.vault.getFiles().map((f) => f.path);
				const targets = findUnmappedFilesUnderFolder(
					folderPath,
					all,
					Object.keys(this.settings.fileMappings),
					this.settings.mayaspaceRoot,
					Object.keys(this.settings.orgMappings),
				);
				// 0건이어도 로그를 남긴다 — "무반응"의 원인(이미 매핑됨/인덱싱 지연/org 폴더 밖)을 구분하기 위해.
				console.log(`[mayaspace] folder scan: all=${all.length} targets=${targets.length} under ${folderPath}`);
				if (targets.length > 0) this.uploadQueue.enqueueAll(targets);
			}
		} finally {
			this.folderCreateScans.delete(folderPath);
		}
	}

	private async hydrateAllPlaceholders(): Promise<void> {
		const entries = Object.entries(this.settings.fileMappings).filter(
			([path]) => !this.liveCollab.activePaths().includes(path),
		);
		// 대형 vault: 동기화 시 일괄 read를 폐지하고 background drip + 열 때 채우기(lazy)로 전환한다.
		// 받는 N명이 한꺼번에 전체 본문을 당기면 outbound가 터지므로(예: 1만 파일×30명).
		if (entries.length > this.settings.lazyHydrateThreshold) {
			this.startBackgroundHydrate();
			return;
		}
		// 작은 vault: 기존 eager — 본문을 미리 받아 네이티브 검색/그래프가 바로 동작하게.
		// Bounded concurrency: a large vault would otherwise either fire one REST
		// read per file at once (connection flood) or crawl one-at-a-time. Run a
		// small fixed number of workers over a shared queue.
		await runBounded(HYDRATE_CONCURRENCY, entries, ([path, mapping]) =>
			this.hydrateFileTracked(path, mapping),
		);
	}

	/** hydrate를 감싸 진행 상태를 배지에 반영한다(시작=hydrating, 완료=파생). */
	private async hydrateFileTracked(path: string, mapping: FileMapping): Promise<void> {
		this.hydratingPaths.add(path);
		this.decorator?.updateContent(path, "hydrating");
		try {
			await this.hydrateFile(path, mapping);
		} finally {
			this.hydratingPaths.delete(path);
			this.decorator?.updateContent(path, this.contentStateFor(path));
		}
	}

	/** 대형 vault용: 한가할 때 placeholder를 분당 N개씩 천천히 채운다(드립). */
	private startBackgroundHydrate(): void {
		if (this.hydrateDripTimer !== null) return; // 이미 도는 중
		this.dripAttempted.clear(); // 새 사이클: 빈 파일 포함 전체 재평가
		if (!this.nextPlaceholderToHydrate()) return; // 받을 게 없으면 시작 안 함
		const perMinute = Math.max(1, this.settings.backgroundHydratePerMinute);
		const intervalMs = Math.max(1000, Math.floor(60000 / perMinute));
		this.hydrateDripTimer = window.setInterval(() => void this.dripHydrateOnce(), intervalMs);
		this.registerInterval(this.hydrateDripTimer);
	}

	private stopBackgroundHydrate(): void {
		if (this.hydrateDripTimer === null) return;
		window.clearInterval(this.hydrateDripTimer);
		this.hydrateDripTimer = null;
	}

	private async dripHydrateOnce(): Promise<void> {
		const next = this.nextPlaceholderToHydrate();
		if (!next) { this.stopBackgroundHydrate(); return; }
		await this.hydrateFileTracked(next[0], next[1]);
		// 본문이 빈 파일은 hydrate 후에도 placeholder로 남는다 — 시도 표시로 다음 틱에 건너뛰어
		// 같은 파일에서 막히지 않게 한다. 본문 있는 파일은 local로 바뀌어 어차피 다시 안 잡힌다.
		this.dripAttempted.add(next[0]);
	}

	/** 아직 본문이 없는(placeholder) 첫 매핑 파일. 없으면 null. */
	private nextPlaceholderToHydrate(): [string, FileMapping] | null {
		for (const [path, mapping] of Object.entries(this.settings.fileMappings)) {
			if (this.dripAttempted.has(path)) continue; // 이미 시도함(빈 파일 livelock 방지)
			if (this.hydratingPaths.has(path)) continue;
			if (this.liveCollab.activePaths().includes(path)) continue;
			if (this.contentStateFor(path) === "placeholder") return [path, mapping];
		}
		return null;
	}

	/** 파일 한 개의 본문 상태(배지용). 받는 중=hydrating, 라이브 세션·size>0=local, 그 외=placeholder. */
	private contentStateFor(path: string): ContentState {
		if (this.hydratingPaths.has(path)) return "hydrating";
		// 라이브 협업 중이면 본문이 에디터에 있으므로 디스크 쓰기 지연과 무관하게 local로 본다.
		if (this.liveCollab?.activePaths().includes(path)) return "local";
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile && file.stat.size > 0 ? "local" : "placeholder";
	}

	/** 매핑된 전 파일의 본문 상태 맵(데코레이터 refresh용). */
	private computeContentStates(): Record<string, ContentState> {
		const out: Record<string, ContentState> = {};
		for (const path of Object.keys(this.settings.fileMappings)) {
			out[path] = this.contentStateFor(path);
		}
		return out;
	}

	private async hydrateFile(path: string, mapping: FileMapping): Promise<void> {
		if (this.liveCollab.activePaths().includes(path)) return;
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			// 이미지: 텍스트 read/modify를 타면 바이트가 깨진다. 빈 placeholder만
			// 바이너리로 채우고, 비어있지 않으면 (텍스트 경로와 같은 원칙으로) 덮지 않는다.
			if (isImagePath(path)) {
				if (file.stat.size > 0) return;
				const { data } = await this.api.readFileBinary(mapping.orgId, mapping.fileId);
				if (data.byteLength === 0) return;
				this.selfWriteHashes.set(path, hashContent(bytesToBase64(data)));
				await this.app.vault.modifyBinary(file, data);
				return;
			}
			const current = await this.app.vault.read(file);
			// vault에 사용자 편집(또는 이전 세션의 본문)이 있으면 덮어쓰지 않는다.
			// 사용자가 오프라인으로 작성한 내용이 옛 서버 본문에 의해 사라지는 케이스를 막는다.
			// CRDT 머지는 yCollab attach 시(즉 사용자가 파일을 열 때) 일어난다.
			if (current.length > 0) return;
			const { content } = await this.api.readFile(mapping.orgId, mapping.fileId);
			if (current === content) return; // already up-to-date (both empty)
			await this.safeModify(file, content);
		} catch (e) {
			console.warn("[mayaspace] hydrate failed", path, e);
		}
	}

	/**
	 * 복원 직후 호출. 파일이 라이브 협업 세션에 붙어 있으면 서버가 라이브 Y.Doc 본문을
	 * 교체했으므로 Hocuspocus가 에디터로 흘려보낸다 — 여기서 손대지 않는다.
	 * 세션이 없으면 서버 본문을 강제로 다시 읽어 vault에 반영한다 (hydrateFile은
	 * 비어있지 않은 본문을 덮지 않으므로 이 경로가 따로 필요하다).
	 */
	private async rehydrateAfterRestore(orgId: string, fileId: string, path: string): Promise<void> {
		if (this.liveCollab.activePaths().includes(path)) return;
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			const { content } = await this.api.readFile(orgId, fileId);
			const current = await this.app.vault.read(file);
			if (current === content) return;
			await this.safeModify(file, content);
		} catch (e) {
			console.warn("[mayaspace] rehydrate after restore failed", path, e);
		}
	}

	// ---------- Background prefetch (live ytext → vault.md) ----------
	//
	// Eager content sync via Hocuspocus. After syncTrees and on every SSE
	// file.created, every mapped file gets a background Hocuspocus session
	// whose ytext changes are debounced into vault.modify (~500ms). That
	// makes other users' edits land in the local vault in near-real-time —
	// search, graph, explorer preview all reflect remote changes without
	// the user opening the file.
	//
	// Prefetch shares its Hocuspocus session with any active LiveCollab
	// session via MayaspaceSync's refCount, so detaching the editor doesn't
	// kill the background channel. Active path's flushes are skipped — the
	// editor owns the content while it's visible.

	private async startPrefetchAll(): Promise<void> {
		const scope = this.settings.prefetchAllFiles
			? Object.keys(this.settings.fileMappings)
			: this.livePrefetchScope();
		for (const path of scope) {
			const mapping = this.settings.fileMappings[path];
			if (mapping) void this.startPrefetch(path, mapping);
		}
	}

	// Bounded set of paths that get a live background session when full-vault
	// prefetch is off: the currently open file plus the most-recently-opened
	// ones (and any already-active live-collab path). The rest stay fresh via
	// tree polling + SSE invalidation + lazy hydration on open.
	private livePrefetchScope(): string[] {
		const scope = new Set<string>(this.liveCollab.activePaths());
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file && this.mappings.getFile(active.file.path)) scope.add(active.file.path);
		for (const path of this.recentlyOpened) scope.add(path);
		return Array.from(scope).filter((p) => this.settings.fileMappings[p]);
	}

	/**
	 * SSE로 갓 받은 파일에 prefetch(WS 세션)를 열어야 하는지. 전체 prefetch 설정이거나
	 * 라이브 스코프(연 파일·최근 연 파일)일 때만 — 벌크로 받은 나머지는 열 때 붙어 WS 폭주를 막는다.
	 * startPrefetchAll의 스코프 정책과 동일하게 맞춘다.
	 */
	private shouldLivePrefetch(path: string): boolean {
		return this.settings.prefetchAllFiles || this.livePrefetchScope().includes(path);
	}

	private noteRecentlyOpened(path: string, mapping: FileMapping): void {
		this.recentlyOpened = this.recentlyOpened.filter((p) => p !== path);
		this.recentlyOpened.push(path);
		const evicted = this.recentlyOpened.splice(0, Math.max(0, this.recentlyOpened.length - this.settings.livePrefetchLimit));
		void this.startPrefetch(path, mapping);
		// Evicted paths leave the live scope. Keep the session only if the file
		// is still open in the editor (active-leaf prefetch); otherwise stop it
		// so the scope stays bounded.
		const stillOpen = new Set(this.liveCollab.activePaths());
		for (const old of evicted) {
			if (!stillOpen.has(old)) this.stopPrefetch(old);
		}
	}

	private async startPrefetch(path: string, mapping: FileMapping): Promise<void> {
		// 이미지는 Yjs(텍스트 전용) 대상이 아니다 — 세션을 열면 garbage ytext가 생긴다.
		if (isImagePath(path)) return;
		if (this.prefetches.has(path)) return;
		// Capture the sync instance we open with. On server-URL change
		// rebuildBackendClients() swaps this.sync for a new instance; cleanup
		// must closeDoc on the SAME instance it opened, not the replacement.
		const sync = this.sync;
		try {
			const handle = await sync.openDoc(mapping.orgId, mapping.fileId);
			const ytext = (handle.doc as any).getText("content") as { toString(): string; observe(cb: () => void): void; unobserve(cb: () => void): void };
			let timer: ReturnType<typeof setTimeout> | null = null;
			const flush = async () => {
				timer = null;
				// Active LiveCollab session owns the vault for this path —
				// dumpContent on detach handles it. Skip to avoid racing.
				if (this.liveCollab.activePaths().includes(path)) return;
				const content = ytext.toString();
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return;
				try {
					const current = await this.app.vault.read(file);
					// writable 파일은 빈 placeholder만 채우고 non-empty는 yCollab attach 머지에
					// 위임(사용자 편집 보호). read-only 파일은 보호할 편집이 없으니 서버 내용으로
					// 덮어써 동기화를 유지한다.
					const writable = can(this.permsForFileId(mapping.orgId, mapping.fileId), UPDATE);
					if (!shouldApplyPrefetch(current, content, writable)) return;
					await this.safeModify(file, content);
				} catch (e) {
					console.warn("[mayaspace] prefetch flush failed", path, e);
				}
			};
			const observer = () => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(flush, 500);
			};
			ytext.observe(observer);
			const cleanup = () => {
				try { ytext.unobserve(observer); } catch { /* doc destroyed */ }
				if (timer) clearTimeout(timer);
				sync.closeDoc(mapping.orgId, mapping.fileId).catch(() => undefined);
			};
			this.prefetches.set(path, cleanup);
			// Immediate first flush in case the doc already has content.
			void flush();
		} catch (e) {
			console.warn("[mayaspace] prefetch openDoc failed", path, e);
		}
	}

	private stopPrefetch(path: string): void {
		const cleanup = this.prefetches.get(path);
		if (!cleanup) return;
		cleanup();
		this.prefetches.delete(path);
	}

	private stopAllPrefetches(): void {
		for (const path of Array.from(this.prefetches.keys())) {
			this.stopPrefetch(path);
		}
	}

	// Delete the on-disk IndexedDB snapshot for every mapped file. Called on
	// logout so revoked / signed-out content doesn't stay cached on the device.
	private async purgeAllCaches(): Promise<void> {
		for (const mapping of Object.values(this.settings.fileMappings)) {
			await this.sync.purgeDoc(mapping.orgId, mapping.fileId).catch(() => undefined);
		}
	}

	restartTreePoller(): void {
		this.treePoller?.stop();
		this.treePoller = null;
		if (this.settings.treePollIntervalSec <= 0) return;
		if (!this.settings.tokenSet) return;
		this.treePoller = new TreePoller(
			this.api,
			this.app.vault as unknown as PollerVault,
			{
				getKnownFiles: () => this.settings.fileMappings,
				addFileMapping: async (path, mapping) => {
					this.settings.fileMappings[path] = mapping;
					await this.saveSettings();
					this.decorator.refresh();
					// Newly discovered file — pull its body too.
					await this.hydrateFile(path, mapping);
				},
				removeFileMapping: async (path) => {
					delete this.settings.fileMappings[path];
					await this.saveSettings();
					this.decorator.refresh();
				},
				sanitizeOrgFolderName: sanitizeFolderName,
				mayaspaceRoot: () => this.settings.mayaspaceRoot,
				// 동기화 진행 중 또는 tree.changed 직후 창에선 삭제 판정을 건너뛴다 — 벌크 수신 중
				// 매핑 flux를 다른 시점 트리와 비교해 멀쩡한 파일을 손실로 오판하는 것을 막는다.
				isSyncing: () => this.syncingTrees || Date.now() - this.lastTreeChangeAt < POLLER_DELETE_FREEZE_MS,
				// Same diff+detach logic as syncTrees — admin's permission changes
				// must reach the plugin via the periodic poll, not just on next login.
				onOrgPermissions: (perms) => this.applyOrgPermissions(perms),
				onFilePermissions: (fileId, perms) => this.applyFilePermission(fileId, perms),
				onFileLost: (path, mapping) => {
					this.stopPrefetch(path);
					if (this.liveCollab.activePaths().includes(path)) {
						void this.liveCollab.detach(path).catch(() => undefined);
					}
					void this.sync.purgeDoc(mapping.orgId, mapping.fileId).catch(() => undefined);
					delete this.settings.filePermissions[mapping.fileId];
					new Notice("MayaSpace: 접근 권한이 없어 로컬에서 제거되었습니다.");
				},
				onError: (e) => console.warn("[mayaspace] poller", e),
			},
			this.settings.treePollIntervalSec * 1000,
		);
		this.treePoller.start();
	}

	/**
	 * Replace orgPermissions cache and detach affected sessions when bits shrink.
	 * Called from both syncTrees (login + manual) and tree-poller (every 30s).
	 */
	private async applyOrgPermissions(perms: Record<string, number>): Promise<void> {
		const prev = { ...this.settings.orgPermissions };
		this.settings.orgPermissions = perms;
		await this.saveSettings();

		for (const orgId of new Set([...Object.keys(prev), ...Object.keys(perms)])) {
			const before = prev[orgId] ?? 0;
			const after = perms[orgId] ?? 0;
			const lostRead = !!(before & READ) && !(after & READ);
			const lostUpdate = !!(before & UPDATE) && !(after & UPDATE);
			const gainedRead = !(before & READ) && !!(after & READ);

			if (lostRead || lostUpdate) {
				let removed = 0;
				for (const [path, m] of Object.entries(this.settings.fileMappings)) {
					if (m.orgId !== orgId) continue;
					if (this.liveCollab.activePaths().includes(path)) {
						await this.liveCollab.detach(path).catch(() => undefined);
						// 편집권만 잃고 읽기는 유지되면: 로컬 발산(전환 직전 친 편집)을 버리고
						// 서버에서 재시드해 read-only로 다시 붙인다 → 로컬=서버.
						if (lostUpdate && !lostRead) {
							await this.sync.purgeDoc(m.orgId, m.fileId).catch(() => undefined);
							await this.liveCollab.attach(path, m, { readOnly: true }).catch(() => undefined);
						}
					}
					if (lostRead) {
						// 읽기 권한이 사라지면 로컬 .md까지 지운다. 씽크파일만 지우면
						// .md에 마지막 동기화 본문이 남아 회수된 유저가 계속 읽을 수 있다.
						// 서버가 원본이라 재초대·권한 복구 시 tree-poller가 다시 받아온다.
						this.stopPrefetch(path);
						await this.sync.purgeDoc(m.orgId, m.fileId).catch(() => undefined);
						// 매핑을 먼저 지운다. vault.delete가 vault.on('delete') →
						// handleVaultDelete를 부르는데, 매핑이 남아 있으면 이미 권한 없는
						// 파일을 서버에 또 DELETE 시도한다.
						delete this.settings.fileMappings[path];
						delete this.settings.filePermissions[m.fileId];
						const f = this.app.vault.getAbstractFileByPath(path);
						if (f) await this.app.vault.delete(f).catch(() => undefined);
						removed++;
					}
				}
				if (lostRead) {
					await this.saveSettings();
					this.decorator.refresh();
					new Notice(`MayaSpace: 읽기 권한이 회수되어 ${removed}개 파일을 로컬에서 제거했습니다.`);
				} else if (lostUpdate) new Notice("MayaSpace: 편집 권한이 회수되었습니다.");
			}

			// 권한 회복 시 prefetch 재시작 — 회수 사이클로 prefetch가 죽었으면
			// handleVaultModify가 새 단발성 세션을 띄우게 되어 IndexedDB
			// flush race가 생긴다. 미리 살려두면 그 race가 사라진다.
			if (gainedRead) {
				for (const [path, m] of Object.entries(this.settings.fileMappings)) {
					if (m.orgId !== orgId) continue;
					if (this.prefetches.has(path)) continue;
					void this.startPrefetch(path, m);
				}
			}
		}
	}

	/**
	 * 파일별 effective_permissions 갱신. write 권한이 사라진 전환(editable→readonly)을
	 * 감지하면 로컬 발산을 버리고 서버에서 재시드한다 — readonly는 "로컬=서버"여야 한다.
	 */
	private applyFilePermission(fileId: string, perms: number): void {
		const prev = this.settings.filePermissions[fileId];
		this.settings.filePermissions[fileId] = perms;
		if (prev !== undefined && can(prev, UPDATE) && !can(perms, UPDATE)) {
			void this.reseedReadOnly(fileId);
		}
	}

	/**
	 * readonly로 강등된 파일의 로컬 CRDT(IndexedDB)를 비워 전환 직전에 친 로컬 op을 폐기하고,
	 * 열려 있던 파일은 read-only로 재attach해 서버 본문에서 다시 시드한다. 열려있지 않은 파일은
	 * 다음 prefetch가 서버 내용으로 .md를 덮어쓴다(shouldApplyPrefetch, writable=false).
	 */
	private async reseedReadOnly(fileId: string): Promise<void> {
		const located = this.locateFileById(fileId);
		if (!located) return;
		const { orgId, path } = located;
		const wasActive = this.liveCollab.activePaths().includes(path);
		if (wasActive) await this.liveCollab.detach(path).catch(() => undefined);
		await this.sync.purgeDoc(orgId, fileId).catch(() => undefined);
		if (wasActive) {
			await this.liveCollab.attach(path, { orgId, fileId }, { readOnly: true }).catch(() => undefined);
		}
	}

	private locateFileById(fileId: string): { orgId: string; path: string } | null {
		for (const [path, m] of Object.entries(this.settings.fileMappings)) {
			if (m.fileId === fileId) return { orgId: m.orgId, path };
		}
		return null;
	}

	// ---------- SSE ----------

	/**
	 * Exchange the Bearer JWT for a short-lived single-use SSE ticket so the
	 * JWT never appears in the EventSource URL (server logs / proxies). Called
	 * once per (re)connect by MayaspaceEvents — the ticket is consumed on
	 * connect and expires in ~30s.
	 */
	private async fetchSseTicket(): Promise<string> {
		const token = await this.auth.getValidAccessToken();
		const res = await this.fetcher({
			method: "POST",
			url: `${this.settings.serverUrl}/v1/auth/sse-ticket`,
			headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
		});
		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			throw new Error(`sse-ticket failed: ${res.status} ${errText}`);
		}
		const body = await res.json<{ ticket?: string }>();
		if (!body.ticket) throw new Error("sse-ticket response missing ticket");
		return body.ticket;
	}

	private startEventsSubscription(): void {
		if (!this.settings.tokenSet) return;
		this.events?.unsubscribeAll();

		const did = decodeJwtPayload(this.settings.tokenSet.accessToken).did ?? "";
		console.log("[mayaspace] SSE start: myDid=", did, "orgs=", Object.values(this.settings.orgMappings));
		this.events = new MayaspaceEvents({
			restUrl: this.settings.serverUrl,
			getTicket: () => this.fetchSseTicket(),
			myDeviceId: did,
			handlers: {
				onCreated: async (p) => {
					console.log("[mayaspace] SSE onCreated", p);
					const folder = this.findOrgFolder(p.orgId);
					if (!folder) return;
					let relPath: string;
					try { relPath = canonicalServerPath(p.path); }
					catch (e) { console.warn("[mayaspace] onCreated rejected path", p.path, e); return; }
					const full = `${this.settings.mayaspaceRoot}/${folder}/${relPath}`;
					// Register mapping BEFORE vault.create — vault.create fires
					// vault.on('create') synchronously, and the handler would
					// otherwise see no mapping and POST to the server → 409.
					this.settings.fileMappings[full] = { orgId: p.orgId, fileId: p.fileId };
					// 새 파일 권한 캐시: 서버가 실어준 권위값이 있으면 그걸 쓰고,
					// 없으면 폴더(형제) 기반으로 추정한다. 이게 없으면 tree-poll 전에
					// 이 파일을 편집할 때 permsForFileId가 org-root(=0)로 폴백해 "편집
					// 권한 없음"으로 오판한다. tree-poller가 곧 권위값으로 갱신.
					if (this.settings.filePermissions[p.fileId] === undefined) {
						this.settings.filePermissions[p.fileId] =
							p.effective_permissions ?? this.permsForNewPath(p.orgId, full);
					}
					// 부모 폴더를 먼저 만든 뒤 placeholder를 생성한다(syncOrgTrees와 동일 패턴).
					// 새 하위폴더(예: bulk/.../)로 들어오는 대량 수신에서 폴더가 아직 없으면
					// vault.create가 throw하는데, 과거엔 빈 catch가 조용히 삼켜 '매핑만 있고 파일
					// 없는' 고아 상태를 만들었다(폴러가 영영 못 고침). 실패는 로깅한다.
					try {
						await ensureParentFolders(this.app.vault as unknown as VaultLike, full);
						await ensureFile(this.app.vault as unknown as VaultLike, full);
					} catch (e) {
						console.warn("[mayaspace] onCreated placeholder failed", full, e);
					}
					await this.saveSettings();
					this.decorator.refresh();
					// 받는 쪽 폭주 방지(다른 기기가 100개 벌크 생성 시): 본문 hydrate(REST)는
					// 바운디드 큐로 동시 read를 제한하고, prefetch(WS 세션)는 라이브 스코프
					// (열린 파일·최근 연 파일)에만 연다 — 벌크로 받은 파일은 열 때 붙는다.
					this.hydrateQueue.enqueue(full);
					if (this.shouldLivePrefetch(full)) {
						void this.startPrefetch(full, { orgId: p.orgId, fileId: p.fileId });
					}
				},
				onDeleted: async (p) => {
					console.log("[mayaspace] SSE onDeleted", p);
					// 페이로드 경로로 로컬 경로를 계산해 O(1)로 찾는다(onCreated와 동일). 매핑 전체를
					// 스캔하지 않는다 — 폴더째 삭제 시 이벤트마다의 풀스캔이 O(N²)가 되기 때문.
					const folder = this.findOrgFolder(p.orgId);
					if (!folder) return;
					let relPath: string;
					try { relPath = canonicalServerPath(p.path); }
					catch (e) { console.warn("[mayaspace] onDeleted rejected path", p.path, e); return; }
					const path = `${this.settings.mayaspaceRoot}/${folder}/${relPath}`;
					const m = this.settings.fileMappings[path];
					if (!m || m.orgId !== p.orgId || m.fileId !== p.fileId) return; // 우리 매핑 아님/이미 정리됨

					// Tear down the live editor binding BEFORE purgeDoc destroys
					// the doc. Otherwise the yCollab ViewPlugin keeps transacting
					// on a destroyed Y.Doc and the edits silently stop syncing.
					if (this.liveCollab.activePaths().includes(path)) {
						await this.liveCollab.detach(path).catch(() => undefined);
					}
					this.stopPrefetch(path);
					void this.sync.purgeDoc(m.orgId, m.fileId).catch(() => undefined);
					// Delete mapping BEFORE vault.delete. Otherwise vault.delete
					// fires vault.on('delete') → handleVaultDelete sees the
					// mapping and POSTs DELETE to the server for an already-
					// deleted file.
					delete this.settings.fileMappings[path];
					const f = this.app.vault.getAbstractFileByPath(path);
					if (f) await this.app.vault.delete(f).catch(() => undefined);
					this.saveScheduler.schedule();
					this.decorator.refresh();
				},
				onMoved: async (p) => {
					console.log("[mayaspace] SSE onMoved", p);
					const folder = this.findOrgFolder(p.orgId);
					if (!folder) return;
					let newRelPath: string;
					try { newRelPath = canonicalServerPath(p.newPath); }
					catch (e) { console.warn("[mayaspace] onMoved rejected path", p.newPath, e); return; }
					const newFull = `${this.settings.mayaspaceRoot}/${folder}/${newRelPath}`;
					// Find any existing local mapping for this fileId so we can
					// rename the placeholder in place, preserving the user's
					// open editor state if they were viewing it.
					let oldFull: string | null = null;
					for (const [path, m] of Object.entries(this.settings.fileMappings)) {
						if (m.orgId === p.orgId && m.fileId === p.fileId) {
							oldFull = path;
							break;
						}
					}
					if (oldFull && oldFull !== newFull) {
						// Update mappings FIRST so the resulting vault.on('rename')
						// handler treats this as our work and skips api.moveFile.
						this.stopPrefetch(oldFull);
						delete this.settings.fileMappings[oldFull];
						this.settings.fileMappings[newFull] = { orgId: p.orgId, fileId: p.fileId };
						// 이동 후 새 경로 기준 권한. 이동은 권한 경계를 넘을 수 있으니
						// 서버가 실어준 값이 있으면 권위값으로 갱신, 없으면 빈 경우만 추정.
						if (p.effective_permissions !== undefined) {
							this.settings.filePermissions[p.fileId] = p.effective_permissions;
						} else if (this.settings.filePermissions[p.fileId] === undefined) {
							this.settings.filePermissions[p.fileId] = this.permsForNewPath(p.orgId, newFull);
						}
						const oldAbstract = this.app.vault.getAbstractFileByPath(oldFull);
						if (oldAbstract) {
							try { await this.app.vault.rename(oldAbstract, newFull); }
							catch (e) { console.warn("[mayaspace] vault.rename failed", oldFull, "→", newFull, e); }
						} else if (!this.app.vault.getAbstractFileByPath(newFull)) {
							try { await this.app.vault.create(newFull, ""); } catch { /* race */ }
						}
						void this.startPrefetch(newFull, { orgId: p.orgId, fileId: p.fileId });
					} else if (!oldFull) {
						// We never knew about this file locally — create a placeholder.
						this.settings.fileMappings[newFull] = { orgId: p.orgId, fileId: p.fileId };
						if (!this.app.vault.getAbstractFileByPath(newFull)) {
							try { await this.app.vault.create(newFull, ""); } catch { /* race */ }
						}
						void this.startPrefetch(newFull, { orgId: p.orgId, fileId: p.fileId });
					}
					await this.saveSettings();
					this.decorator.refresh();
				},
				onUpdated: async (p) => {
					console.log("[mayaspace] SSE onUpdated", p);
					// Find local path for this fileId
					let localPath: string | null = null;
					for (const [path, m] of Object.entries(this.settings.fileMappings)) {
						if (m.orgId === p.orgId && m.fileId === p.fileId) {
							localPath = path;
							break;
						}
					}
					if (!localPath) return;
					// If a live session is open on this path, the editor owns
					// the content via Hocuspocus — don't overwrite the vault
					// file from REST or we'd race with ytext.
					if (this.liveCollab.activePaths().includes(localPath)) {
						console.log("[mayaspace] onUpdated skipped (live session active)", localPath);
						return;
					}
					// 동시 REST read 제한(다른 기기 벌크 수정 시 폭주 방지) — 바운디드 큐로.
					this.hydrateQueue.enqueue(localPath);
				},
				onPresenceChanged: (p) => {
					if (this.collabSidebar) {
						this.collabSidebar.onPresenceChanged(p.orgId, p.fileId, p.userIds);
					}
				},
				// 권한 변경 신호: 30초 폴러를 기다리지 않고 즉시(디바운스) 권한 재동기화.
				onAccessChanged: () => this.resyncOnAccessChange(),
				// 트리 무효화 신호(대량 burst coalesce): 디바운스 트리 재동기화 + 폴러 삭제 보류 창 갱신.
				onTreeChanged: () => {
					this.lastTreeChangeAt = Date.now();
					this.resyncOnTreeChange();
				},
				onError: (orgId, e) => console.warn("[mayaspace] SSE error", orgId, e),
			},
		});
		const orgIds = Object.values(this.settings.orgMappings);
		if (orgIds.length === 0) {
			console.warn("[mayaspace] SSE: no orgs to subscribe — log in / sync first");
		}
		for (const orgId of orgIds) {
			console.log("[mayaspace] SSE subscribe →", orgId);
			this.events.subscribe(orgId);
		}
	}

	// ---------- Vault → server ----------

	/**
	 * decideImageDrop이 ignore면 Obsidian 기본 동작에 맡긴다. 이미지가 아닌
	 * 파일이 섞인 혼합 드롭도 ignore — 절반만 가로채면 기본 동작과 충돌한다.
	 */
	private handleImageDrop(files: File[], evt: Event, editor: Editor, notePath: string | null): void {
		if (files.length === 0 || !notePath) return;
		const parsed = parseMayaspacePath(notePath, this.settings.mayaspaceRoot);
		const orgId = parsed ? this.settings.orgMappings[parsed.orgName] : undefined;
		const canCreate = orgId ? checkCreate(this.permsForNewPath(orgId, notePath)).allowed : false;

		const decisions = files.map((f) =>
			decideImageDrop({
				notePath,
				inOrgFolder: !!orgId,
				canCreate,
				fileName: f.name,
				fileSize: f.size,
				now: new Date(),
				rand: makeRand4(),
			}),
		);
		if (decisions.some((d) => d.kind === "ignore")) return;

		evt.preventDefault();
		const actionable = decisions as Array<Exclude<ReturnType<typeof decideImageDrop>, { kind: "ignore" }>>;
		void this.saveDroppedImages(files, actionable, editor);
	}

	private async saveDroppedImages(
		files: File[],
		decisions: Array<{ kind: "block"; message: string } | { kind: "save"; folder: string; vaultPath: string; linkText: string }>,
		editor: Editor,
	): Promise<void> {
		for (let i = 0; i < files.length; i++) {
			const d = decisions[i];
			if (d.kind === "block") {
				new Notice(d.message);
				continue;
			}
			try {
				const data = await files[i].arrayBuffer();
				if (!(await this.app.vault.adapter.exists(d.folder))) {
					await this.app.vault.createFolder(d.folder);
				}
				// createBinary가 vault.on('create')를 발화 → handleVaultCreate의
				// 이미지 분기가 서버 업로드까지 처리한다 (여기서 업로드하지 않는다).
				await this.app.vault.createBinary(d.vaultPath, data);
				editor.replaceSelection(d.linkText + "\n");
			} catch (e) {
				console.warn("[mayaspace] image drop save failed", d.vaultPath, e);
				new Notice("MayaSpace: 이미지 저장에 실패했습니다.");
			}
		}
	}

	/**
	 * @param opts.bulk 폴더 드랍/reconcile 같은 일괄 업로드 경로. 파일당 prefetch(WS 세션)와
	 *   권한-거부 Notice를 억제하고(100개 드랍 시 폭주 방지), 일시적 실패(429/5xx/네트워크)는
	 *   삼키지 않고 던져 업로드 큐가 백오프 재시도하게 한다. 로컬이 원본이라 hydrate도 불필요.
	 */
	private async handleVaultCreate(path: string, opts: { bulk?: boolean } = {}): Promise<void> {
		if (this.mappings.getFile(path)) return; // our own placeholder
		if (this.inflightCreates.has(path)) return; // race: second event for same path
		if (this.crossOrgBlocked.has(path)) return; // cross-org 이동으로 차단된 경로 — 새 org에 업로드 안 함
		const parsed = parseMayaspacePath(path, this.settings.mayaspaceRoot);
		if (!parsed) return;
		const orgId = this.settings.orgMappings[parsed.orgName];
		if (!orgId) return;
		const perms = this.permsForNewPath(orgId, path);
		const guard = checkCreate(perms);
		if (!guard.allowed) {
			if (!opts.bulk) new Notice(guard.message!);
			return;
		}
		this.inflightCreates.add(path);
		try {
			// If the file was created with body content (Claude CLI, Finder
			// copy, terminal `echo > file.md`), pull it now and send to the
			// server in the same POST so the body isn't lost. Empty
			// placeholder remains the common path (Obsidian "New note") and
			// skips this branch.
			let contentBase64: string | undefined;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				try {
					if (isImagePath(path)) {
						// 이미지: 텍스트 read는 바이트를 깨뜨린다. readBinary→base64.
						const data = await this.app.vault.readBinary(file);
						if (data.byteLength > MAX_IMAGE_BYTES) {
							new Notice("MayaSpace: 이미지가 20MiB를 초과해 업로드하지 않습니다. (로컬에는 남아 있음)");
							return;
						}
						contentBase64 = bytesToBase64(data);
						// OS가 createBinary 직후 modify를 추가 발화해도 같은 바이트면
						// handleVaultModify 이미지 분기가 echo로 인식해 재업로드하지 않는다.
						this.selfWriteHashes.set(path, hashContent(contentBase64));
					} else {
						const body = await this.app.vault.read(file);
						if (body && body.length > 0) {
							contentBase64 = utf8ToBase64(body);
						}
					}
				} catch (e) {
					console.warn("[mayaspace] reading new file body for upload", path, e);
				}
			}
			let meta: FileMeta;
			try {
				meta = await this.api.createFile(orgId, parsed.relPath, contentBase64);
			} catch (e) {
				// 이미 존재(409, 또는 일부 서버가 누설하는 duplicate-key 500)는 멱등하게 스킵 — 실패 아님.
				if (isPathConflict(e)) {
					console.log("[mayaspace] create skipped — server says path exists", path);
					return;
				}
				console.warn("[mayaspace] createFile failed", path, e);
				// bulk는 위로 던져 업로드 큐가 처리한다: 일시적(429/5xx/네트워크)은 백오프 재시도,
				// 비복구(401/402/403/413)는 isTransient=false라 재시도 없이 failed로 집계된다.
				// 과거엔 비복구 에러를 조용히 삼켜(processed로 위장) 누락을 숨겼다(관측성 회귀 수정).
				if (opts.bulk) throw e;
				// 단일 생성엔 큐가 없으니 사용자에게 직접 알린다(원문 본문은 노출하지 않음).
				new Notice(`MayaSpace: 업로드 실패 (${httpStatusOf(e) ?? "네트워크"}) — 'Sync now'로 다시 시도하세요.`);
				return;
			}
			this.settings.fileMappings[path] = { orgId, fileId: meta.id };
			this.settings.filePermissions[meta.id] = perms;
			await this.saveSettings();
			this.decorator.refresh();
			await this.attachCreatedFileIfActive(path, { orgId, fileId: meta.id });
			// prefetch(WS 세션)는 라이브 스코프(연/최근 연 파일)일 때만 연다 — onCreated 수신 경로와
			// 동일 정책. 벌크로 만든/이동한 파일 100개에 파일당 세션을 열면 폭주하므로, 그 파일을 열 때
			// 붙인다. 활성 파일은 위 attachCreatedFileIfActive가 이미 처리.
			if (this.shouldLivePrefetch(path)) void this.startPrefetch(path, { orgId, fileId: meta.id });
		} finally {
			this.inflightCreates.delete(path);
		}
	}

	private async attachCreatedFileIfActive(path: string, mapping: FileMapping): Promise<void> {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!active?.file || active.file.path !== path) return;
		if (!can(this.permsForFileId(mapping.orgId, mapping.fileId), UPDATE)) return;
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await this.liveCollab.attach(path, mapping).catch((e) =>
			console.warn("[mayaspace] attach newly-created file failed", path, e),
		);
	}

	/**
	 * External vault.modify (CLI, Finder, another editor). Push the new
	 * content to the server so other clients see it. Several short-circuits
	 * keep us from racing or looping with our own writes.
	 */
	private async handleVaultModify(path: string): Promise<void> {
		const mapping = this.mappings.getFile(path);
		if (!mapping) return; // not a mayaspace-tracked file
		const perms = this.permsForFileId(mapping.orgId, mapping.fileId);
		const g = checkUpdate(perms);
		if (!g.allowed) {
			new Notice(g.message!);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		// 이미지: ytext 경로(아래)는 텍스트 전용이므로 절대 타면 안 된다.
		// REST PUT raw 바이너리로 직행한다. etag는 GET으로 받아온다(매핑에 없음).
		if (isImagePath(path)) {
			let data: ArrayBuffer;
			try {
				data = await this.app.vault.readBinary(file);
			} catch (e) {
				console.warn("[mayaspace] vault.readBinary failed", path, e);
				return;
			}
			const b64 = bytesToBase64(data);
			if (this.selfWriteHashes.get(path) === hashContent(b64)) return; // 자기 쓰기 echo
			if (data.byteLength > MAX_IMAGE_BYTES) {
				new Notice("MayaSpace: 이미지가 20MiB를 초과해 동기화하지 않습니다.");
				return;
			}
			try {
				const { etag } = await this.api.readFileBinary(mapping.orgId, mapping.fileId);
				await this.api.writeFileBinary(mapping.orgId, mapping.fileId, data, etag);
				this.selfWriteHashes.set(path, hashContent(b64));
				console.log("[mayaspace] image modify pushed via REST", path);
			} catch (e) {
				console.warn("[mayaspace] image modify push failed", path, e);
			}
			return;
		}

		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (e) {
			console.warn("[mayaspace] vault.read failed", path, e);
			return;
		}

		// Echo of our own safeModify write — content matches what we wrote, so
		// ignore it instead of re-pushing. The OS watcher can fire modify twice
		// for one write, so we keep the recorded hash (don't delete it here):
		// both echoes match and stay suppressed. An external edit lands with a
		// different hash and falls through to the merge below. This guard runs
		// BEFORE both the live and prefetch branches, so our own dumps (detach /
		// prefetch flush via safeModify) never loop back into ytext.
		if (this.selfWriteHashes.get(path) === hashContent(content)) return;

		// A live editor session is open: merge the external disk write into the
		// SAME Y.Doc yCollab is bound to. The change then renders in the open
		// editor and broadcasts to every peer. Earlier we skipped entirely here,
		// silently losing the disk change (A2). We do NOT open a separate
		// session for this path — that would seed a second Y.Doc and diverge.
		const liveHandle = this.liveCollab.handleFor(path);
		if (liveHandle) {
			const ytext = (liveHandle.doc as YDocWithText).getText("content");
			const changed = mergeDiskIntoYtext(liveHandle.doc as YDocWithText, ytext, content);
			if (changed) console.log("[mayaspace] external modify merged into live ytext", path);
			return;
		}

		// No live editor, but a Hocuspocus session may be open via prefetch.
		// Push through ytext so the change broadcasts to every connected client
		// in real time. The server REST PUT path is blocked while a Hocuspocus
		// session is active — only the WS route works in that state.
		try {
			const handle = await this.sync.openDoc(mapping.orgId, mapping.fileId);
			try {
				const ytext = (handle.doc as YDocWithText).getText("content");
				const changed = mergeDiskIntoYtext(handle.doc as YDocWithText, ytext, content);
				if (changed) console.log("[mayaspace] external modify pushed via ytext", path);
			} finally {
				// closeDoc just decrements the refcount; prefetch keeps the
				// session alive if it was holding a ref.
				await this.sync.closeDoc(mapping.orgId, mapping.fileId);
			}
		} catch (e) {
			console.warn("[mayaspace] external modify push failed", path, e);
		}
	}

	private async handleVaultRename(oldPath: string, newPath: string): Promise<void> {
		const parsedOld = parseMayaspacePath(oldPath, this.settings.mayaspaceRoot);
		const parsedNew = parseMayaspacePath(newPath, this.settings.mayaspaceRoot);

		// 둘 다 mayaspace 밖이면 무관.
		if (!parsedOld && !parsedNew) return;

		// 밖 → 안: 사실상 신규 진입. vault.on('create')는 발화하지 않으므로 전역 업로드 큐로 태운다
		// (폴더째 이동 시 파일별 rename이 100개 와도 동시성 제한). 권한 체크는 handleVaultCreate가 한다.
		if (!parsedOld && parsedNew) {
			this.uploadQueue.enqueue(newPath);
			return;
		}

		// 안 → 밖: 서버 파일은 보존하고 매핑도 유지한다. 삭제 권한이 없으면
		// 그 사실을 알리고, 있어도 공유 폴더 밖 이동은 지원하지 않는다고 안내.
		// (spec 6.4: mapping preserved so user can recover by moving back in.)
		if (parsedOld && !parsedNew) {
			const orgId = this.settings.orgMappings[parsedOld.orgName];
			const oldMapping = this.settings.fileMappings[oldPath];
			const perms = oldMapping ? this.permsForFileId(orgId, oldMapping.fileId) : (this.settings.orgPermissions[orgId] ?? 0);
			if (!can(perms, DELETE)) {
				new Notice("MayaSpace: 삭제 권한이 없어 로컬만 이동되고 서버 파일은 그대로 유지됩니다.");
			} else {
				new Notice("MayaSpace: 공유 폴더 밖 이동은 지원하지 않습니다. 삭제하려면 폴더 안에서 삭제 명령을 사용하세요.");
			}
			// Mapping preserved — server file remains intact regardless of permission.
			return;
		}

		// 둘 다 mayaspace 안 — 기존 move 로직.
		const mapping = this.settings.fileMappings[oldPath];
		if (!mapping) return;
		// cross-org 이동은 미지원(org=별개 vault라 서버에 cross-org move API 없음). 차단하고 새 org에
		// 업로드되지 않게 막는다(원본 org 유지). Notice는 폴더째 이동 시 100번 안 뜨게 디바운스.
		if (parsedOld!.orgName !== parsedNew!.orgName) {
			this.crossOrgBlocked.add(newPath);
			this.warnCrossOrgMove();
			return;
		}
		const orgIdSame = this.settings.orgMappings[parsedNew!.orgName];
		const permsSame = orgIdSame ? this.permsForNewPath(orgIdSame, newPath) : 0;
		const gMove = checkMove(permsSame);
		if (!gMove.allowed) { new Notice(gMove.message!); return; }
		// 같은 org 이동: 폴더째 100개를 옮겨도 동시 moveFile burst가 안 나게 큐로(동시성 제한 + 재시도).
		this.pendingMoves.set(newPath, {
			oldPath,
			orgId: mapping.orgId,
			fileId: mapping.fileId,
			newRelPath: parsedNew!.relPath,
		});
		this.moveQueue.enqueue(newPath);
	}

	/** moveQueue 워커: 보류 중인 같은 org 이동 1건을 서버에 반영하고 매핑을 갱신한다. */
	private async runQueuedMove(newPath: string): Promise<void> {
		const move = this.pendingMoves.get(newPath);
		if (!move) return;
		try {
			await this.api.moveFile(move.orgId, move.fileId, move.newRelPath);
			delete this.settings.fileMappings[move.oldPath];
			this.settings.fileMappings[newPath] = { orgId: move.orgId, fileId: move.fileId };
			await this.saveSettings();
			this.decorator.refresh();
			this.pendingMoves.delete(newPath);
		} catch (e) {
			if (isPathConflict(e)) { this.pendingMoves.delete(newPath); return; } // 이미 이동됨(멱등)
			if (isTransientHttp(e)) throw e; // 큐가 백오프 재시도 — pendingMoves 유지
			console.warn("[mayaspace] moveFile failed", move.oldPath, "→", newPath, e);
			this.pendingMoves.delete(newPath);
		}
	}

	private async handleVaultDelete(path: string): Promise<void> {
		const mapping = this.settings.fileMappings[path];
		if (!mapping) return;
		const perms = this.permsForFileId(mapping.orgId, mapping.fileId);
		const g = checkDelete(perms);
		if (!g.allowed) {
			new Notice(g.message + " 로컬은 삭제됐지만 서버 파일은 보존됩니다.");
			// Mapping preserved — if user regains DELETE later, the server still has the file.
			return;
		}
		this.stopPrefetch(path);
		await this.sync.purgeDoc(mapping.orgId, mapping.fileId).catch(() => undefined);
		try {
			await this.api.deleteFile(mapping.orgId, mapping.fileId);
		} catch (e) {
			// 일시적 실패(타임아웃·429·5xx)는 큐가 백오프 재시도하도록 위로 던진다 — 매핑을
			// 지우지 않아 다음 시도가 같은 파일을 다시 삭제할 수 있게 한다. 대량 삭제 burst로
			// 깨진 deleteFile이 여기서 복구된다. 404는 이미 삭제된 것이라 멱등 처리(로그 생략).
			if (isTransientHttp(e)) throw e;
			if (httpStatusOf(e) !== 404) console.warn("[mayaspace] deleteFile failed", path, e);
		}
		delete this.settings.fileMappings[path];
		this.saveScheduler.schedule();
		this.decorator.refresh();
	}

	// ---------- Misc ----------

	async smokeCheckCapabilities(): Promise<void> {
		try {
			const caps = await this.api.capabilities();
			new Notice(`MayaSpace: capabilities OK\n${JSON.stringify(caps)}`);
		} catch (e) {
			if (e instanceof EtagMismatchError) return; // not applicable here
			new Notice(`MayaSpace: capabilities failed: ${describe(e)}`);
		}
	}

	/**
	 * Detach every other live session and (re)bind the now-settled file.
	 * Called debounced from file-open so rapid in-leaf switching doesn't thrash
	 * the binding lifecycle against Obsidian's EditorState replacement.
	 */
	private async rebindActiveFile(path: string, mapping: FileMapping | null): Promise<void> {
		// Detach every other active path. Obsidian reuses the same EditorView
		// when switching files in a leaf; a leftover binding would stack a
		// second yCollab on the same view.
		for (const other of this.liveCollab.activePaths()) {
			if (other === path) continue;
			await this.liveCollab.detach(other).catch(() => undefined);
			delete this.fileStatuses[other];
		}
		if (!mapping) return;
		// Wait one frame so Obsidian finishes any follow-up reconfigure before
		// we dispatch the new compartment.
		await new Promise<void>((r) => requestAnimationFrame(() => r()));
		const perms = this.permsForFileId(mapping.orgId, mapping.fileId);
		if (!can(perms, READ)) {
			console.log("[mayaspace] skip live-collab attach: no READ perm", path);
			return;
		}
		const readOnly = !can(perms, UPDATE);
		await this.liveCollab.attach(path, mapping, { readOnly }).catch((e) =>
			console.warn("[mayaspace] attach failed", path, e),
		);
	}

	private findEditorViewForPath(path: string): EditorView | null {
		// Prefer the active MarkdownView — that's the EditorView the user is
		// actually looking at. Obsidian can have multiple leaves with the same
		// file (split view, sidebar) and our binding must follow the one in
		// focus, otherwise edits land in an off-screen view.
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active && active.file?.path === path) {
			const cm = (active.editor as any)?.cm as EditorView | undefined;
			if (cm) return cm;
		}
		let found: EditorView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			if (view.file?.path !== path) return;
			const cm = (view.editor as any)?.cm as EditorView | undefined;
			if (cm) found = cm;
		});
		return found;
	}

	private async detachClosedFiles(): Promise<void> {
		const openPaths = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file) openPaths.add(view.file.path);
		});
		for (const activePath of this.liveCollab.activePaths()) {
			if (openPaths.has(activePath)) continue;
			await this.liveCollab.detach(activePath);
			delete this.fileStatuses[activePath];
		}
	}

	/** 기존 파일: filePermissions[fileId] → 없으면 org 루트 폴백. */
	private permsForFileId(orgId: string, fileId: string): number {
		return this.settings.filePermissions[fileId] ?? this.settings.orgPermissions[orgId] ?? 0;
	}

	/** 신규 파일(아직 fileId 없음): 같은 폴더 형제 파일의 perms로 추론, 없으면 org 루트 폴백. */
	private permsForNewPath(orgId: string, fullPath: string): number {
		// 서버 ACL은 경로 prefix로 상속된다 — 가장 가까운 조상 폴더의 권한을 물려받는다(없으면 org 루트).
		// 직속 형제만 보면 폴더째 드래그로 생긴 새 하위폴더 파일이 루트로 잘못 폴백돼 막혔다(회귀).
		return inheritedPermsForPath(
			orgId,
			fullPath,
			this.settings.fileMappings,
			this.settings.filePermissions,
			this.settings.orgPermissions[orgId] ?? 0,
		);
	}

	/** 그룹 C(사이드바)용 공개 헬퍼: relPath 기준 유효 권한. 매핑 있으면 fileId, 없으면 폴더 추론. */
	getEffectivePermsForPath(orgId: string, relPath: string): number {
		const folder = this.findOrgFolder(orgId);
		if (!folder) return this.settings.orgPermissions[orgId] ?? 0;
		const fullPath = `${this.settings.mayaspaceRoot}/${folder}/${relPath}`;
		const m = this.settings.fileMappings[fullPath];
		if (m) return this.permsForFileId(orgId, m.fileId);
		return this.permsForNewPath(orgId, fullPath);
	}

	private findOrgFolder(orgId: string): string | null {
		for (const [folder, id] of Object.entries(this.settings.orgMappings)) {
			if (id === orgId) return folder;
		}
		return null;
	}

	private renderStatusBar(): void {
		if (!this.statusBarItem) return;
		const email = this.settings.accountEmail;
		this.statusBarItem.setText(email ? `MayaSpace: ${email}` : "MayaSpace: signed out");
	}
}

function decodeJwtPayload(token: string): { sub?: string; did?: string; email?: string } {
	const [, payload] = token.split(".");
	if (!payload) return {};
	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		return JSON.parse(atob(normalized));
	} catch {
		return {};
	}
}

function describe(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// Cap on simultaneous REST hydrate reads (see hydrateAllPlaceholders / #6).
const HYDRATE_CONCURRENCY = 4;
// 폴더 드랍/이동 후 Obsidian 인덱싱이 늦을 수 있어 한 번이 아니라 점증 간격으로 재스캔한다.
// 늦게 들어온 파일(특히 큰 첨부)을 놓치지 않게. 각 스캔 결과는 큐가 dedupe하므로 멱등.
const FOLDER_RESCAN_DELAYS_MS = [1200, 4000, 10000];
// 전역 업로드 큐: 동시성 상한(서버 DB 풀보다 작게 — /me 등 다른 요청이 굶지 않게)과 재시도.
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_MAX_ATTEMPTS = 5;
const UPLOAD_BACKOFF_BASE_MS = 500;
const UPLOAD_BACKOFF_MAX_MS = 8000;
// 대량 변경 시 매 건 saveSettings 대신 디스크 쓰기를 이 창으로 합친다(메모리는 즉시 반영).
const SAVE_DEBOUNCE_MS = 500;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Debounce for file-open → live-collab (re)bind. Long enough to coalesce rapid
// in-leaf file switching, short enough to feel instant once the user settles.
const FILE_OPEN_DEBOUNCE_MS = 150;

// tree.changed(I1 벌크 coalesce) 직후 이 창 동안엔 폴러의 삭제 판정을 보류한다.
// 벌크 수신은 디바운스된 syncTrees가 여러 번 몰아치며 공유 매핑을 갱신하므로, 그 사이
// 빈틈에 폴이 돌아 멀쩡한 파일을 손실로 오판하지 않게 한다(디바운스 800ms + 동기화 시간 여유).
const POLLER_DELETE_FREEZE_MS = 10000;

/**
 * Run `worker` over `items` with at most `limit` in flight at once. A shared
 * cursor feeds the workers so a slow item doesn't stall the others. Rejections
 * are swallowed per item (worker is expected to handle its own errors).
 */
async function runBounded<T>(limit: number, items: T[], worker: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const runOne = async (): Promise<void> => {
		while (cursor < items.length) {
			const item = items[cursor++];
			await worker(item).catch(() => undefined);
		}
	};
	const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
	await Promise.all(workers);
}

/**
 * Fast non-cryptographic content hash (FNV-1a) for self-write detection. We
 * only need to tell "is this byte-for-byte the content I just wrote" apart from
 * "someone else changed it", so collision resistance isn't required.
 */
function hashContent(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/**
 * UTF-8 safe base64 encode. btoa() alone throws on non-Latin1 characters,
 * which we hit constantly with Korean / Japanese filenames and bodies.
 */
function utf8ToBase64(s: string): string {
	return btoa(unescape(encodeURIComponent(s)));
}
