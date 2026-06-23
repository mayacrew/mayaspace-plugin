import { App, Modal, Notice, Setting } from "obsidian";
import type { MayaspaceApi } from "../api/mayaspace-api";
import { expiryToISO, type ExpiryOption } from "../lib/share-expiry";

/** 활성 노트를 외부 공유 링크로 만든다(권한·만료 선택 → 링크 클립보드 복사). */
export class ShareCreateModal extends Modal {
	private permission: "read" | "edit" = "edit";
	private expiry: ExpiryOption = "none";

	constructor(
		app: App,
		private readonly api: MayaspaceApi,
		private readonly orgId: string,
		private readonly fileId: string,
		private readonly title: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("MayaSpace: 링크로 공유");
		this.contentEl.createEl("p", { text: this.title });

		new Setting(this.contentEl).setName("권한").addDropdown((d) =>
			d.addOption("edit", "편집").addOption("read", "읽기 전용").setValue("edit")
				.onChange((v) => { this.permission = v === "read" ? "read" : "edit"; }),
		);
		new Setting(this.contentEl).setName("만료").addDropdown((d) =>
			d.addOption("none", "없음").addOption("7d", "7일").addOption("30d", "30일").setValue("none")
				.onChange((v) => { this.expiry = v as ExpiryOption; }),
		);

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const create = buttons.createEl("button", { text: "링크 만들기", cls: "mod-cta" });
		create.onclick = () => void this.create();
		const cancel = buttons.createEl("button", { text: "취소" });
		cancel.onclick = () => this.close();
	}

	private async create(): Promise<void> {
		try {
			const out = await this.api.createShare(this.orgId, this.fileId, {
				permission: this.permission,
				expiresAt: expiryToISO(this.expiry, Date.now()),
			});
			await navigator.clipboard.writeText(out.url).catch(() => undefined);
			new Notice(`공유 링크 복사됨 (${this.permission === "edit" ? "편집" : "읽기 전용"})`);
			this.close();
		} catch (e) {
			new Notice(`공유 실패: ${(e as Error)?.message ?? e}`);
		}
	}
}

/** 활성 노트의 활성 공유 목록·취소. */
export class ShareManageModal extends Modal {
	constructor(
		app: App,
		private readonly api: MayaspaceApi,
		private readonly orgId: string,
		private readonly fileId: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("MayaSpace: 공유 관리");
		await this.render();
	}

	private async render(): Promise<void> {
		this.contentEl.empty();
		let shares;
		try {
			shares = await this.api.listShares(this.orgId, this.fileId);
		} catch (e) {
			this.contentEl.createEl("p", { text: `불러오기 실패: ${(e as Error)?.message ?? e}` });
			return;
		}
		if (shares.length === 0) {
			this.contentEl.createEl("p", { text: "활성 공유가 없습니다." });
			return;
		}
		for (const s of shares) {
			new Setting(this.contentEl)
				.setName(s.permission === "edit" ? "편집" : "읽기 전용")
				.setDesc(s.expires_at ? `만료 ${new Date(s.expires_at).toLocaleString()}` : "무기한")
				.addButton((b) =>
					b.setButtonText("공유 해제").setWarning().onClick(async () => {
						try {
							await this.api.revokeShare(this.orgId, s.id);
							new Notice("공유 링크를 해제했습니다.");
						} catch (e) {
							new Notice(`공유 해제 실패: ${(e as Error)?.message ?? e}`);
						}
						await this.render();
					}),
				);
		}
	}
}
