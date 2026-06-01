import { App, Modal, Setting } from "obsidian";

/** 단순 예/아니오 확인 다이얼로그. onConfirm은 '예'를 누를 때만 실행된다. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private confirmText: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.title });
		contentEl.createEl("p", { text: this.message });
		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(this.confirmText).setWarning().onClick(() => {
					this.close();
					this.onConfirm();
				}),
			)
			.addButton((btn) => btn.setButtonText("취소").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
