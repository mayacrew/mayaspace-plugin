import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MayaspacePlugin from "./main";
import type { TokenSet } from "./auth/mayaspace-auth";
import type { FileMapping } from "./vault/tree-sync";

export interface MayaspaceSettings {
	serverUrl: string;
	wsUrl: string;
	displayName: string;
	mayaspaceRoot: string;
	treePollIntervalSec: number;
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
	serverUrl: "http://localhost:3000",
	wsUrl: "ws://localhost:3001",
	displayName: "",
	mayaspaceRoot: "MayaSpace",
	treePollIntervalSec: 30,
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
						this.plugin.rebuildBackendClients();
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
						this.plugin.rebuildBackendClients();
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
					.setButtonText("Open admin site")
					.setCta()
					.onClick(() => this.openAdminSite()),
			);
	}

	private openAdminSite(): void {
		const base = this.plugin.settings.serverUrl.replace(/\/+$/, "");
		if (!base) {
			new Notice("MayaSpace: set the REST URL first.");
			return;
		}
		// Server only exposes GET /admin (dashboard); per-org actions are all POST forms.
		window.open(`${base}/admin`, "_blank");
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
