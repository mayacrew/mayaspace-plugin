import { App, Modal, Notice } from "obsidian";
import type { MayaspaceApi } from "../api/mayaspace-api";
import { groupFileIdsByOrg, type TrashRow } from "../lib/trash-group";

/** orgFolder→orgId 매핑 전체에서 트래시를 모아 다중 선택 복구 모달을 띄운다. */
export class TrashModal extends Modal {
	private rows: TrashRow[] = [];
	private readonly selected = new Set<string>();
	private filter = "";

	private listEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private selectAllCb: HTMLInputElement | null = null;
	private restoreBtn: HTMLButtonElement | null = null;

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

	private filtered(): TrashRow[] {
		const q = this.filter.trim().toLowerCase();
		if (!q) return this.rows;
		return this.rows.filter((r) => r.path.toLowerCase().includes(q));
	}

	private render(): void {
		this.contentEl.empty();
		if (this.rows.length === 0) {
			this.contentEl.createEl("p", { text: "삭제된 파일이 없습니다." });
			return;
		}

		const toolbar = this.contentEl.createDiv({ cls: "mayaspace-trash-toolbar" });

		const filterInput = toolbar.createEl("input", { type: "text", cls: "mayaspace-trash-filter" });
		filterInput.placeholder = "경로로 필터";
		filterInput.value = this.filter;
		filterInput.oninput = () => { this.filter = filterInput.value; this.renderRows(); this.syncToolbar(); };

		const selectAll = toolbar.createEl("label", { cls: "mayaspace-trash-selectall" });
		this.selectAllCb = selectAll.createEl("input", { type: "checkbox" });
		this.selectAllCb.onchange = () => this.toggleAllFiltered();
		selectAll.createSpan({ text: "전체 선택" });

		this.countEl = toolbar.createSpan({ cls: "mayaspace-trash-count" });

		this.listEl = this.contentEl.createDiv({ cls: "mayaspace-trash-list" });
		this.renderRows();

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		this.restoreBtn = buttons.createEl("button", { text: "선택 복구", cls: "mod-cta" });
		this.restoreBtn.onclick = () => void this.restore();
		const cancel = buttons.createEl("button", { text: "취소" });
		cancel.onclick = () => this.close();

		this.syncToolbar();
	}

	private renderRows(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		const rows = this.filtered();
		if (rows.length === 0) {
			list.createEl("p", { text: "필터와 일치하는 파일이 없습니다.", cls: "mayaspace-trash-empty" });
			return;
		}
		for (const row of rows) {
			const label = list.createEl("label", { cls: "mayaspace-trash-row" });
			const cb = label.createEl("input", { type: "checkbox" });
			cb.checked = this.selected.has(row.id);
			cb.onchange = () => {
				if (cb.checked) this.selected.add(row.id); else this.selected.delete(row.id);
				this.syncToolbar();
			};
			label.createSpan({ cls: "mayaspace-trash-path", text: row.path });
			label.createSpan({ cls: "mayaspace-trash-meta", text: formatDate(row.deleted_at) });
		}
	}

	private toggleAllFiltered(): void {
		const rows = this.filtered();
		const allSelected = rows.length > 0 && rows.every((r) => this.selected.has(r.id));
		if (allSelected) rows.forEach((r) => this.selected.delete(r.id));
		else rows.forEach((r) => this.selected.add(r.id));
		this.renderRows();
		this.syncToolbar();
	}

	/** 카운트·전체선택 체크박스·복구 버튼 상태를 현재 선택/필터에 맞춘다. */
	private syncToolbar(): void {
		const rows = this.filtered();
		const selectedInView = rows.filter((r) => this.selected.has(r.id)).length;

		if (this.countEl) this.countEl.setText(`${rows.length}개 중 ${selectedInView}개 선택`);
		if (this.selectAllCb) {
			this.selectAllCb.checked = rows.length > 0 && selectedInView === rows.length;
			this.selectAllCb.indeterminate = selectedInView > 0 && selectedInView < rows.length;
		}
		if (this.restoreBtn) {
			this.restoreBtn.disabled = this.selected.size === 0;
			this.restoreBtn.setText(this.selected.size > 0 ? `선택 복구 (${this.selected.size})` : "선택 복구");
		}
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

function formatDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
