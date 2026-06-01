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

import { MarkdownView, Notice, Plugin, TFile, requestUrl } from "obsidian";

import {
	MayaspaceSettings,
	DEFAULT_SETTINGS,
	MayaspaceSettingTab,
} from "./settings";

import { MayaspaceAuth, type TokenSet } from "./auth/mayaspace-auth";
import { PluginTokenStorage } from "./auth/token-storage";
import { PasswordLoginModal } from "./auth/password-login-modal";
import { SignupModal } from "./auth/signup-modal";
import { ConfirmModal } from "./auth/confirm-modal";

import { makeObsidianFetcher } from "./api/mayaspace-http";
import { MayaspaceApi, EtagMismatchError, type FileMeta } from "./api/mayaspace-api";

import { MayaspaceSync, defaultHocuspocusFactory } from "./sync/mayaspace-sync";
import { LiveCollabSession } from "./sync/live-collab-session";
import { bindYCollab } from "./sync/yCollab-binder";

import { syncOrgTrees, type FileMapping } from "./vault/tree-sync";
import { FileMappings } from "./vault/file-mappings";
import { TreePoller, type PollerVault } from "./vault/tree-poller";

import { MayaspaceEvents } from "./events/sse-subscriber";

import { makePeerIdentity } from "./ui/peer-identity";
import { ExplorerDecorator, type SyncStatus } from "./ui/explorer-decorator";

import { parseMayaspacePath, sanitizeFolderName } from "./lib/path";
import { EditorView } from "@codemirror/view";

export default class MayaspacePlugin extends Plugin {
	settings!: MayaspaceSettings;
	auth!: MayaspaceAuth;
	api!: MayaspaceApi;
	sync!: MayaspaceSync;
	liveCollab!: LiveCollabSession;
	mappings!: FileMappings;
	decorator!: ExplorerDecorator;

	private events: MayaspaceEvents | null = null;
	private treePoller: TreePoller | null = null;
	private statusBarItem: HTMLElement | null = null;
	private fileStatuses: Record<string, SyncStatus> = {};
	private settingTab: MayaspaceSettingTab | null = null;
	private prefetches = new Map<string, () => void>();
	// Paths we just wrote via vault.modify ourselves. Used to suppress the
	// resulting vault.on('modify') event so handleVaultModify doesn't treat
	// our own dump as an external edit and re-PUT it to the server.
	private selfWrites = new Map<string, ReturnType<typeof setTimeout>>();
	// Paths whose POST /files is currently in flight. The raw fs.watch under
	// Obsidian fires vault.on('create') more than once for a single CLI
	// write (and Obsidian's own index update can fire it again), so without
	// this guard we'd race two creates → second one hits the (orgId,path)
	// unique constraint on the server and surfaces a 500.
	private inflightCreates = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.buildMappings();
		this.rebuildBackendClients();
		this.buildLiveCollab();
		this.buildDecorator();

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
			await this.liveCollab.attach(path, mapping).catch((e) =>
				console.warn("[mayaspace] attach on layout-ready failed", path, e),
			);
		}, 0);
	}

	async onunload(): Promise<void> {
		this.treePoller?.stop();
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

	private buildLiveCollab(): void {
		this.liveCollab = new LiveCollabSession({
			api: this.api,
			sync: this.sync,
			bindEditor: (view, handle) => {
				const identity = makePeerIdentity(this.settings.displayName || null, this.settings.accountEmail);
				return bindYCollab(view as EditorView, handle, identity);
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
			name: "MayaSpace: Open admin site",
			callback: () => {
				const base = this.settings.serverUrl.replace(/\/+$/, "");
				if (!base) { new Notice("Set REST URL first."); return; }
				window.open(`${base}/admin`, "_blank");
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
				// Defer to a macro task. queueMicrotask is too early: Obsidian
				// fires file-open BEFORE it replaces the leaf's EditorState on
				// in-leaf file switches, and the replacement happens in a
				// later macro task. If we dispatch during the microtask flush,
				// our compartment effect lands on a state that's about to be
				// discarded — first attach (empty leaf) is fine, but every
				// subsequent file switch in the same leaf silently drops the
				// binding. setTimeout puts us after that replacement.
				setTimeout(async () => {
					// Detach every other active path FIRST. Obsidian reuses the
					// same EditorView when the user switches files in a leaf;
					// leaving a previous binding alive means the new attach
					// stacks a second yCollab on the same view.
					for (const other of this.liveCollab.activePaths()) {
						if (other === file.path) continue;
						await this.liveCollab.detach(other).catch(() => undefined);
						delete this.fileStatuses[other];
					}
					if (!mapping) return;
					// Wait one more frame after teardown so Obsidian has a
					// chance to finish any follow-up reconfigure it does in
					// response to the file change before we dispatch the new
					// compartment.
					await new Promise<void>((r) => requestAnimationFrame(() => r()));
					await this.liveCollab.attach(file.path, mapping).catch((e) =>
						console.warn("[mayaspace] attach failed", file.path, e),
					);
				}, 0);
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
	}

	/**
	 * Wrap vault.modify so we can recognise our own writes inside the
	 * subsequent vault.on('modify') event. Without this guard, every dump
	 * from prefetch / hydrate / detach would round-trip back to the server
	 * as an "external edit" → write loop.
	 */
	private async safeModify(file: TFile, content: string): Promise<void> {
		const existing = this.selfWrites.get(file.path);
		if (existing) clearTimeout(existing);
		// Modify fires synchronously then OS file watcher fires it again
		// shortly after. 1.5s covers both windows.
		this.selfWrites.set(
			file.path,
			setTimeout(() => this.selfWrites.delete(file.path), 1500),
		);
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
		const deviceName = `Obsidian (${navigator.platform || "desktop"})`;
		new PasswordLoginModal(
			this.app,
			this.auth,
			deviceName,
			this.postAuthSuccess,
			() => this.startSignup(),
		).open();
	}

	async startSignup(): Promise<void> {
		const deviceName = `Obsidian (${navigator.platform || "desktop"})`;
		new SignupModal(
			this.app,
			this.auth,
			deviceName,
			this.postAuthSuccess,
			() => this.startConnect(),
		).open();
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
		const entries = Object.entries(this.settings.fileMappings);
		for (const [path, mapping] of entries) {
			if (this.liveCollab.activePaths().includes(path)) continue;
			await this.hydrateFile(path, mapping);
		}
	}

	private async hydrateFile(path: string, mapping: FileMapping): Promise<void> {
		if (this.liveCollab.activePaths().includes(path)) return;
		try {
			const { content } = await this.api.readFile(mapping.orgId, mapping.fileId);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const current = await this.app.vault.read(file);
				if (current === content) return; // already up-to-date
				await this.safeModify(file, content);
			}
		} catch (e) {
			console.warn("[mayaspace] hydrate failed", path, e);
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
		for (const [path, mapping] of Object.entries(this.settings.fileMappings)) {
			void this.startPrefetch(path, mapping);
		}
	}

	private async startPrefetch(path: string, mapping: FileMapping): Promise<void> {
		if (this.prefetches.has(path)) return;
		try {
			const handle = await this.sync.openDoc(mapping.orgId, mapping.fileId);
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
					if (current === content) return;
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
				this.sync.closeDoc(mapping.orgId, mapping.fileId).catch(() => undefined);
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
				onError: (e) => console.warn("[mayaspace] poller", e),
			},
			this.settings.treePollIntervalSec * 1000,
		);
		this.treePoller.start();
	}

	// ---------- SSE ----------

	private startEventsSubscription(): void {
		if (!this.settings.tokenSet) return;
		this.events?.unsubscribeAll();

		const did = decodeJwtPayload(this.settings.tokenSet.accessToken).did ?? "";
		console.log("[mayaspace] SSE start: myDid=", did, "orgs=", Object.values(this.settings.orgMappings));
		this.events = new MayaspaceEvents({
			restUrl: this.settings.serverUrl,
			token: this.settings.tokenSet.accessToken,
			myDeviceId: did,
			handlers: {
				onCreated: async (p) => {
					console.log("[mayaspace] SSE onCreated", p);
					const folder = this.findOrgFolder(p.orgId);
					if (!folder) return;
					const full = `${this.settings.mayaspaceRoot}/${folder}/${p.path}`;
					// Register mapping BEFORE vault.create — vault.create fires
					// vault.on('create') synchronously, and the handler would
					// otherwise see no mapping and POST to the server → 409.
					this.settings.fileMappings[full] = { orgId: p.orgId, fileId: p.fileId };
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
						this.stopPrefetch(path);
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
					const newFull = `${this.settings.mayaspaceRoot}/${folder}/${p.newPath}`;
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

	private async handleVaultCreate(path: string): Promise<void> {
		if (this.mappings.getFile(path)) return; // our own placeholder
		if (this.inflightCreates.has(path)) return; // race: second event for same path
		const parsed = parseMayaspacePath(path, this.settings.mayaspaceRoot);
		if (!parsed) return;
		const orgId = this.settings.orgMappings[parsed.orgName];
		if (!orgId) return;
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
					const body = await this.app.vault.read(file);
					if (body && body.length > 0) {
						contentBase64 = utf8ToBase64(body);
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
			await this.saveSettings();
			this.decorator.refresh();
			// Start a background prefetch session so future external/remote
			// edits on this file stream into the vault automatically.
			void this.startPrefetch(path, { orgId, fileId: meta.id });
		} finally {
			this.inflightCreates.delete(path);
		}
	}

	/**
	 * External vault.modify (CLI, Finder, another editor). Push the new
	 * content to the server so other clients see it. Several short-circuits
	 * keep us from racing or looping with our own writes.
	 */
	private async handleVaultModify(path: string): Promise<void> {
		// Our own vault.modify call — ignore the resulting event.
		if (this.selfWrites.has(path)) return;
		const mapping = this.mappings.getFile(path);
		if (!mapping) return; // not a mayaspace-tracked file
		// While a live editor session is open, yCollab/Hocuspocus owns the
		// content. Any external write here would race with ytext updates.
		// Obsidian rarely fires modify for the active editor's own keystrokes
		// (those go through CM6), so this skip is safe.
		if (this.liveCollab.activePaths().includes(path)) return;

		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (e) {
			console.warn("[mayaspace] vault.read failed", path, e);
			return;
		}

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
			await this.handleVaultCreate(newPath);
			return;
		}

		// 안 → 밖: 서버 데이터 보호 차원에서 거부 토스트. 사용자가 명시적으로
		// 삭제하려면 공유 폴더 안에서 삭제 명령을 쓰도록 안내. 로컬 매핑은
		// stale 상태이므로 정리한다. (드래그를 되돌리진 않는다 — 사용자가 직접
		// 다시 옮기면 위 "밖 → 안" 분기로 재진입.)
		if (parsedOld && !parsedNew) {
			new Notice(
				"MayaSpace: 공유 폴더 밖으로 이동은 지원하지 않습니다. 삭제하려면 폴더 안에서 삭제 명령을 사용하세요.",
			);
			if (this.settings.fileMappings[oldPath]) {
				delete this.settings.fileMappings[oldPath];
				await this.saveSettings();
				this.decorator.refresh();
			}
			return;
		}

		// 둘 다 mayaspace 안 — 기존 move 로직.
		const mapping = this.settings.fileMappings[oldPath];
		if (!mapping) return;
		if (parsedOld!.orgName !== parsedNew!.orgName) {
			new Notice("MayaSpace: cross-org moves aren't supported yet.");
			return;
		}
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
		this.stopPrefetch(path);
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

/**
 * UTF-8 safe base64 encode. btoa() alone throws on non-Latin1 characters,
 * which we hit constantly with Korean / Japanese filenames and bodies.
 */
function utf8ToBase64(s: string): string {
	return btoa(unescape(encodeURIComponent(s)));
}
