import { App, Modal, Notice } from "obsidian";
import type { MayaspaceApi } from "../api/mayaspace-api";
import { groupFileIdsByOrg, type TrashRow } from "../lib/trash-group";

/** orgFolder→orgId 매핑 전체에서 트래시를 모아 다중 선택 복구 모달을 띄운다. */
export class TrashModal extends Modal {
	private rows: TrashRow[] = [];
	private readonly selected = new Set<string>();

	constructor(
		app: App,
		private readonly api: MayaspaceApi,
		private readonly orgs: { folder: string; orgId: string }[],
		private readonly onDone: () => void,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText("MayaSpace: 삭제된 파일 복구");
		this.contentEl.createEl("p", { text: "불러오는 중…" });
		try {
			this.rows = [];
			for (const { folder, orgId } of this.orgs) {
				const items = await this.api.listTrash(orgId);
				for (const it of items) {
					this.rows.push({ orgId, id: it.id, path: `${folder}/${it.path}`, deleted_at: it.deleted_at });
				}
			}
			this.render();
		} catch (e) {
			this.contentEl.empty();
			this.contentEl.createEl("p", { text: `불러오기 실패: ${(e as Error)?.message ?? e}` });
		}
	}

	private render(): void {
		this.contentEl.empty();
		if (this.rows.length === 0) {
			this.contentEl.createEl("p", { text: "삭제된 파일이 없습니다." });
			return;
		}
		const list = this.contentEl.createDiv();
		for (const row of this.rows) {
			const label = list.createEl("label", { cls: "mayaspace-trash-row" });
			const cb = label.createEl("input", { type: "checkbox" });
			cb.onchange = () => { if (cb.checked) this.selected.add(row.id); else this.selected.delete(row.id); };
			label.createSpan({ text: ` ${row.path}` });
		}
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const restore = buttons.createEl("button", { text: "선택 복구", cls: "mod-cta" });
		restore.onclick = () => void this.restore();
		const cancel = buttons.createEl("button", { text: "취소" });
		cancel.onclick = () => this.close();
	}

	private async restore(): Promise<void> {
		const byOrg = groupFileIdsByOrg(this.rows, this.selected);
		let restored = 0;
		let failed = 0;
		for (const [orgId, ids] of Object.entries(byOrg)) {
			const summary = await this.api.restoreFiles(orgId, ids);
			restored += summary.restored.length;
			failed += summary.failed.length;
		}
		new Notice(`복구 ${restored}개, 실패 ${failed}개`);
		this.close();
		this.onDone();
	}
}
