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

import { Editor, MarkdownView, Notice, Plugin, TFile, requestUrl } from "obsidian";

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

import { MayaspaceSync, defaultHocuspocusFactory } from "./sync/mayaspace-sync";
import { LiveCollabSession } from "./sync/live-collab-session";
import { bindYCollab } from "./sync/yCollab-binder";
import { shouldApplyPrefetch } from "./sync/prefetch-policy";
import { debounce } from "./lib/debounce";

import { syncOrgTrees, type FileMapping } from "./vault/tree-sync";
import { FileMappings } from "./vault/file-mappings";
import { TreePoller, type PollerVault } from "./vault/tree-poller";

import { MayaspaceEvents } from "./events/sse-subscriber";

import { makePeerIdentity } from "./ui/peer-identity";
import { ExplorerDecorator, type SyncStatus } from "./ui/explorer-decorator";
import { CollabSidebarView, VIEW_TYPE_COLLAB, type CollabSidebarCallbacks } from "./ui/collab-sidebar";

import { parseMayaspacePath, sanitizeFolderName, canonicalServerPath } from "./lib/path";
import { READ, UPDATE, CREATE, DELETE, can } from "./lib/permissions";
import { isImagePath, bytesToBase64, MAX_IMAGE_BYTES, makeRand4, decideImageDrop } from "./lib/attachments";
import { checkCreate, checkUpdate, checkDelete, checkMove } from "./permissions/permission-guard";
import { EditorView } from "@codemirror/view";

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

	private events: MayaspaceEvents | null = null;
	private collabSidebar: CollabSidebarView | null = null;
	private treePoller: TreePoller | null = null;
	// 동시 syncTrees 실행 방지 플래그.
	private syncingTrees = false;
	// 서버 access.changed 신호 → 권한 즉시 재동기화. 짧게 몰아쳐도 한 번만 돌도록 디바운스.
	private readonly resyncOnAccessChange = debounce(() => {
		void this.syncTrees().catch((e) => console.warn("[mayaspace] access.changed resync", e));
	}, 800);
	private statusBarItem: HTMLElement | null = null;
	private fileStatuses: Record<string, SyncStatus> = {};
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
	// Debounce timer for file-open → live-collab (re)binding. See file-open
	// handler: coalesces rapid in-leaf file switching so it binds once settled.
	private fileOpenTimer: ReturnType<typeof setTimeout> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.buildMappings();
		this.rebuildBackendClients();
		this.buildLiveCollab();
		this.buildDecorator();

		this.buildCollabSidebar();

		this.settingTab = new MayaspaceSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.registerCommands();

		this.statusBarItem = this.addStatusBarItem();
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
		this.treePoller?.stop();
		if (this.fileOpenTimer) clearTimeout(this.fileOpenTimer);
		this.events?.unsubscribeAll();
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
		});
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
				if (!(f instanceof TFile)) return;
				this.handleVaultCreate(f.path).catch((e) => console.warn("[mayaspace] create", e));
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (!(f instanceof TFile)) return;
				this.handleVaultRename(oldPath, f.path).catch((e) => console.warn("[mayaspace] rename", e));
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (!(f instanceof TFile)) return;
				this.handleVaultDelete(f.path).catch((e) => console.warn("[mayaspace] delete", e));
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

	private async hydrateAllPlaceholders(): Promise<void> {
		const entries = Object.entries(this.settings.fileMappings).filter(
			([path]) => !this.liveCollab.activePaths().includes(path),
		);
		// Bounded concurrency: a large vault would otherwise either fire one REST
		// read per file at once (connection flood) or crawl one-at-a-time. Run a
		// small fixed number of workers over a shared queue.
		await runBounded(HYDRATE_CONCURRENCY, entries, ([path, mapping]) =>
			this.hydrateFile(path, mapping),
		);
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
					if (!this.app.vault.getAbstractFileByPath(full)) {
						try { await this.app.vault.create(full, ""); } catch { /* race */ }
					}
					await this.saveSettings();
					this.decorator.refresh();
					// Pull initial body so search / preview work without opening.
					await this.hydrateFile(full, { orgId: p.orgId, fileId: p.fileId });
					// And open a background Hocuspocus session so subsequent
					// edits from the originating user stream in real-time.
					void this.startPrefetch(full, { orgId: p.orgId, fileId: p.fileId });
				},
				onDeleted: async (p) => {
					console.log("[mayaspace] SSE onDeleted", p);
					for (const [path, m] of Object.entries(this.settings.fileMappings)) {
						if (m.orgId !== p.orgId || m.fileId !== p.fileId) continue;
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
					}
					await this.saveSettings();
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
					await this.hydrateFile(localPath, { orgId: p.orgId, fileId: p.fileId });
				},
				onPresenceChanged: (p) => {
					if (this.collabSidebar) {
						this.collabSidebar.onPresenceChanged(p.orgId, p.fileId, p.userIds);
					}
				},
				// 권한 변경 신호: 30초 폴러를 기다리지 않고 즉시(디바운스) 권한 재동기화.
				onAccessChanged: () => this.resyncOnAccessChange(),
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

	private async handleVaultCreate(path: string): Promise<void> {
		if (this.mappings.getFile(path)) return; // our own placeholder
		if (this.inflightCreates.has(path)) return; // race: second event for same path
		const parsed = parseMayaspacePath(path, this.settings.mayaspaceRoot);
		if (!parsed) return;
		const orgId = this.settings.orgMappings[parsed.orgName];
		if (!orgId) return;
		const perms = this.permsForNewPath(orgId, path);
		const guard = checkCreate(perms);
		if (!guard.allowed) {
			new Notice(guard.message!);
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
				const msg = e instanceof Error ? e.message : String(e);
				// 409 path-conflict is the well-formed error. Some server
				// versions leak the underlying DB error as a 500 with
				// "duplicate key value violates unique constraint
				// file_meta_org_path_uq" — same root cause, same handling.
				if (
					/\b409\b/.test(msg) ||
					/path-conflict/.test(msg) ||
					/duplicate key/i.test(msg) ||
					/file_meta_org_path_uq/.test(msg)
				) {
					console.log("[mayaspace] create skipped — server says path exists", path);
					return;
				}
				console.warn("[mayaspace] createFile failed", path, e);
				return;
			}
			this.settings.fileMappings[path] = { orgId, fileId: meta.id };
			this.settings.filePermissions[meta.id] = perms;
			await this.saveSettings();
			this.decorator.refresh();
			await this.attachCreatedFileIfActive(path, { orgId, fileId: meta.id });
			// Start a background prefetch session so future external/remote
			// edits on this file stream into the vault automatically.
			void this.startPrefetch(path, { orgId, fileId: meta.id });
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
		// While a live editor session is open, yCollab/Hocuspocus owns the
		// content. Any external write here would race with ytext updates.
		// Obsidian rarely fires modify for the active editor's own keystrokes
		// (those go through CM6), so this skip is safe.
		if (this.liveCollab.activePaths().includes(path)) return;

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
		// different hash and falls through to the push below.
		if (this.selfWriteHashes.get(path) === hashContent(content)) return;

		// If a Hocuspocus session is open for this file (prefetch keeps one
		// per mapping), push through ytext so the change broadcasts to every
		// other connected client in real time. The server REST PUT path is
		// also blocked while a Hocuspocus session is active — only the WS
		// route works in that state.
		try {
			const handle = await this.sync.openDoc(mapping.orgId, mapping.fileId);
			try {
				const ytext = (handle.doc as { getText(name: string): { toString(): string; delete(idx: number, len: number): void; insert(idx: number, text: string): void } }).getText("content");
				if (ytext.toString() === content) return; // already in sync
				// Replace whole ytext content. Wrapped in a transaction so all
				// peers observe a single coherent update.
				(handle.doc as { transact(fn: () => void): void }).transact(() => {
					ytext.delete(0, ytext.toString().length);
					ytext.insert(0, content);
				});
				console.log("[mayaspace] external modify pushed via ytext", path);
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

		// 밖 → 안: 사실상 신규 진입. vault.on('create')는 발화하지 않으므로
		// handleVaultCreate에 위임해 서버 등록 + 본문 업로드 + prefetch까지 한 번에 처리.
		if (!parsedOld && parsedNew) {
			const orgId = this.settings.orgMappings[parsedNew.orgName];
			const perms = orgId ? this.permsForNewPath(orgId, newPath) : 0;
			const g = checkCreate(perms);
			if (!g.allowed) { new Notice(g.message!); return; }
			await this.handleVaultCreate(newPath);
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
		if (parsedOld!.orgName !== parsedNew!.orgName) {
			new Notice("MayaSpace: cross-org moves aren't supported yet.");
			return;
		}
		const orgIdSame = this.settings.orgMappings[parsedNew!.orgName];
		const permsSame = orgIdSame ? this.permsForNewPath(orgIdSame, newPath) : 0;
		const gMove = checkMove(permsSame);
		if (!gMove.allowed) { new Notice(gMove.message!); return; }
		try {
			await this.api.moveFile(mapping.orgId, mapping.fileId, parsedNew!.relPath);
			delete this.settings.fileMappings[oldPath];
			this.settings.fileMappings[newPath] = mapping;
			await this.saveSettings();
			this.decorator.refresh();
		} catch (e) {
			console.warn("[mayaspace] moveFile failed", oldPath, "→", newPath, e);
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
			console.warn("[mayaspace] deleteFile failed", path, e);
		}
		delete this.settings.fileMappings[path];
		await this.saveSettings();
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
		const parent = fullPath.slice(0, fullPath.lastIndexOf("/"));
		for (const [p, m] of Object.entries(this.settings.fileMappings)) {
			if (m.orgId !== orgId) continue;
			if (p.slice(0, p.lastIndexOf("/")) !== parent) continue;
			const sib = this.settings.filePermissions[m.fileId];
			if (sib !== undefined) return sib;
		}
		return this.settings.orgPermissions[orgId] ?? 0;
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

// Debounce for file-open → live-collab (re)bind. Long enough to coalesce rapid
// in-leaf file switching, short enough to feel instant once the user settles.
const FILE_OPEN_DEBOUNCE_MS = 150;

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
