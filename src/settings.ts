import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MayaspacePlugin from "./main";
import type { TokenSet } from "./auth/mayaspace-auth";
import type { FileMapping } from "./vault/tree-sync";

export interface MayaspaceSettings {
	serverUrl: string;
	wsUrl: string;
	/** 고객 웹앱(apps/web) 주소. 가입·대시보드를 브라우저로 열 때 사용. REST/WS(serverUrl)와 별개. */
	webAppUrl: string;
	displayName: string;
	mayaspaceRoot: string;
	treePollIntervalSec: number;
	/**
	 * Open a background Hocuspocus session for EVERY mapped file at startup.
	 * Off by default: a large vault would open hundreds–thousands of providers
	 * (each a WebSocket + Y.Doc + IndexedDB store), exhausting memory/IO. With
	 * it off, live prefetch is limited to the open + recently-opened files;
	 * everything else stays fresh via tree polling, SSE invalidation, and
	 * lazy hydration when the file is opened.
	 */
	prefetchAllFiles: boolean;
	/** How many recently-opened files keep a live prefetch session. */
	livePrefetchLimit: number;
	/** vault에 이 수를 넘는 파일이 매핑되면 동기화 시 일괄 hydrate 대신 lazy + background drip. */
	lazyHydrateThreshold: number;
	/** 대형 vault에서 background drip이 분당 채우는 placeholder 수. */
	backgroundHydratePerMinute: number;
	tokenSet: TokenSet | null;
	accountEmail: string | null;
	/** sanitized org folder name → orgId */
	orgMappings: Record<string, string>;
	/** vault path → { orgId, fileId } */
	fileMappings: Record<string, FileMapping>;
	/** orgId → effective permissions bits (R|U|C|D) at root path. Refreshed via listOrgs response. */
	orgPermissions: Record<string, number>;
	/** fileId → effective_permissions (경로별 권한 캐시). 트리 sync/poll로 갱신. */
	filePermissions: Record<string, number>;
}

export const DEFAULT_SETTINGS: MayaspaceSettings = {
	serverUrl: "https://api-mayaspace.supermembers.co.kr",
	wsUrl: "wss://api-mayaspace.supermembers.co.kr/ws",
	webAppUrl: "https://mayaspace.supermembers.co.kr",
	displayName: "",
	mayaspaceRoot: "MayaSpace",
	treePollIntervalSec: 30,
	prefetchAllFiles: false,
	livePrefetchLimit: 5,
	lazyHydrateThreshold: 500,
	backgroundHydratePerMinute: 30,
	tokenSet: null,
	accountEmail: null,
	orgMappings: {},
	fileMappings: {},
	orgPermissions: {},
	filePermissions: {},
};

export class MayaspaceSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MayaspacePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "MayaSpace" });

		this.renderServerSection(containerEl);
		this.renderAccountSection(containerEl);
		this.renderEditorSection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderAdminSection(containerEl);
		this.renderDiagnosticsSection(containerEl);
	}

	private renderServerSection(root: HTMLElement): void {
		root.createEl("h3", { text: "Server" });

		new Setting(root)
			.setName("REST URL")
			.setDesc("Base URL for the MayaSpace REST API.")
			.addText((t) =>
				t
					.setPlaceholder("http://localhost:3000")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (v) => {
						this.plugin.settings.serverUrl = v.trim();
						await this.plugin.saveSettings();
						await this.plugin.restartBackend();
					}),
			);

		new Setting(root)
			.setName("Web app URL")
			.setDesc("가입·대시보드를 여는 고객 웹앱 주소 (apps/web).")
			.addText((t) =>
				t
					.setPlaceholder("http://localhost:3002")
					.setValue(this.plugin.settings.webAppUrl)
					.onChange(async (v) => {
						this.plugin.settings.webAppUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("WebSocket URL")
			.setDesc("Hocuspocus collaboration endpoint.")
			.addText((t) =>
				t
					.setPlaceholder("ws://localhost:3001")
					.setValue(this.plugin.settings.wsUrl)
					.onChange(async (v) => {
						this.plugin.settings.wsUrl = v.trim();
						await this.plugin.saveSettings();
						await this.plugin.restartBackend();
					}),
			);
	}

	private renderAccountSection(root: HTMLElement): void {
		root.createEl("h3", { text: "계정" });
		const email = this.plugin.settings.accountEmail;
		const isAuthed = !!this.plugin.settings.tokenSet;

		if (isAuthed) {
			new Setting(root)
				.setName("상태")
				.setDesc(`${email ?? "(이메일 미확인)"} (으)로 로그인됨`)
				.addButton((btn) => {
					btn.setButtonText("로그아웃").setWarning();
					btn.onClick(async () => {
						this.plugin.doLogout();
					});
				});
			return;
		}

		new Setting(root)
			.setName("상태")
			.setDesc("로그인 안 됨")
			.addButton((btn) =>
				btn.setButtonText("로그인").setCta().onClick(() => this.plugin.startConnect()),
			)
			.addButton((btn) =>
				btn.setButtonText("회원가입").onClick(() => this.plugin.startSignup()),
			);
	}

	private renderEditorSection(root: HTMLElement): void {
		root.createEl("h3", { text: "Editor" });

		new Setting(root)
			.setName("Display name")
			.setDesc("Shown next to your cursor when others are editing the same file. Defaults to your email username.")
			.addText((t) =>
				t
					.setPlaceholder("(your email username)")
					.setValue(this.plugin.settings.displayName)
					.onChange(async (v) => {
						this.plugin.settings.displayName = v;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderSyncSection(root: HTMLElement): void {
		root.createEl("h3", { text: "Sync" });

		new Setting(root)
			.setName("MayaSpace root folder")
			.setDesc("Server org folders are mirrored under this folder in the vault.")
			.addText((t) =>
				t
					.setPlaceholder("MayaSpace")
					.setValue(this.plugin.settings.mayaspaceRoot)
					.onChange(async (v) => {
						this.plugin.settings.mayaspaceRoot = v.trim() || "MayaSpace";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Tree poll interval (seconds)")
			.setDesc("Server tree changes are not yet broadcast, so the plugin polls. 0 disables polling.")
			.addText((t) =>
				t
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.treePollIntervalSec))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						this.plugin.settings.treePollIntervalSec = Number.isFinite(n) && n >= 0 ? n : 30;
						await this.plugin.saveSettings();
						this.plugin.restartTreePoller();
					}),
			);

		new Setting(root)
			.setName("Prefetch all files")
			.setDesc("모든 파일에 백그라운드 실시간 세션을 엽니다. 대용량 vault에서는 메모리·IO 폭주를 막기 위해 꺼두세요(기본). 끄면 열린/최근 파일만 실시간이고 나머지는 폴링·열 때 동기화됩니다.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.prefetchAllFiles)
					.onChange(async (v) => {
						this.plugin.settings.prefetchAllFiles = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Live prefetch limit (files)")
			.setDesc("최근 연 파일 중 실시간 세션(WS)을 유지할 개수. 낮을수록 서버 연결·메모리 절약(기본 5, '열린 문서 중심').")
			.addText((t) =>
				t
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.livePrefetchLimit))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						this.plugin.settings.livePrefetchLimit = Number.isFinite(n) && n >= 0 ? n : 5;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Lazy hydrate threshold (files)")
			.setDesc("매핑 파일이 이 수를 넘으면 동기화 시 본문을 한 번에 받지 않고, 열 때 + 백그라운드로 천천히 받습니다(대용량 outbound 폭탄 방지). 작은 vault는 기존대로 한 번에 받습니다.")
			.addText((t) =>
				t
					.setPlaceholder("500")
					.setValue(String(this.plugin.settings.lazyHydrateThreshold))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						this.plugin.settings.lazyHydrateThreshold = Number.isFinite(n) && n >= 0 ? n : 500;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Background hydrate (files / min)")
			.setDesc("대용량 vault에서 아직 안 받은 파일을 백그라운드로 분당 몇 개씩 채울지.")
			.addText((t) =>
				t
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.backgroundHydratePerMinute))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						this.plugin.settings.backgroundHydratePerMinute = Number.isFinite(n) && n >= 1 ? n : 30;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(root)
			.setName("Sync org trees now")
			.setDesc("Refresh org folders and file placeholders from the server.")
			.addButton((btn) =>
				btn.setButtonText("Sync now").onClick(async () => {
					await this.plugin.syncTrees();
					new Notice("MayaSpace: sync complete.");
				}),
			);
	}

	private renderAdminSection(root: HTMLElement): void {
		root.createEl("h3", { text: "Organisations" });

		new Setting(root)
			.setName("Open MayaSpace admin")
			.setDesc("Manage organisations, members, and permissions in your browser.")
			.addButton((btn) =>
				btn
					.setButtonText("Open web dashboard")
					.setCta()
					.onClick(() => this.openAdminSite()),
			);
	}

	private openAdminSite(): void {
		const base = this.plugin.settings.webAppUrl.replace(/\/+$/, "");
		if (!base) {
			new Notice("MayaSpace: set the Web app URL first.");
			return;
		}
		// 고객 웹앱(apps/web)의 대시보드를 연다.
		window.open(`${base}/dashboard`, "_blank");
	}

	private renderDiagnosticsSection(root: HTMLElement): void {
		root.createEl("h3", { text: "Diagnostics" });

		new Setting(root)
			.setName("Check server capabilities")
			.setDesc("Probe /v1/capabilities to confirm the server is reachable.")
			.addButton((btn) =>
				btn.setButtonText("Probe").onClick(() => this.plugin.smokeCheckCapabilities()),
			);
	}
}
