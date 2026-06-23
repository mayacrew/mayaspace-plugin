/**
 * MayaSpace 협업 사이드바 — Obsidian ItemView.
 *
 * 두 섹션:
 *   1. 유저+권한 패널: 이 파일에 접근 가능한 멤버 + 각자의 effective 권한 + 현재 활성 표시
 *   2. 이력 피드: 파일 편집/권한 변경 타임라인 (30일)
 *
 * main.ts가 CollabSidebarCallbacks를 주입하며, 사이드바는 callbacks를 통해서만
 * 데이터를 요청한다 (sync 레이어 직접 import 금지).
 */

import { ItemView, MarkdownRenderer, Modal, setIcon, WorkspaceLeaf } from "obsidian";
import type { FileAccessMember, FileHistoryEntry, VersionContent, VersionListItem } from "../api/mayaspace-api";
import { diffRows, diffWords, collapseRows } from "../lib/markdown-diff";
import type { DiffRow, WordPart } from "../lib/markdown-diff";

export const VIEW_TYPE_COLLAB = "mayaspace-collab";

export interface CollabSidebarCallbacks {
	/** 현재 열린 파일의 접근 멤버+권한 목록 조회. */
	getAccessSummary: (orgId: string, fileId: string) => Promise<FileAccessMember[]>;
	/** 현재 열린 파일의 편집 이력 조회 (최근 20건). */
	getHistory: (orgId: string, fileId: string) => Promise<FileHistoryEntry[]>;
	/** 파일별 현재 활성 userId 목록 (REST snapshot). */
	getPresence: (orgId: string, fileId: string) => Promise<string[]>;
	/** 현재 로그인 사용자의 email. */
	getMyEmail: () => string | null;
	/** 버전 목록 조회 (최신순). */
	listVersions: (orgId: string, fileId: string) => Promise<VersionListItem[]>;
	/** 한 버전의 markdown 본문 조회 (미리보기/diff용). */
	getVersion: (orgId: string, fileId: string, versionId: string) => Promise<VersionContent>;
	/** 수동 체크포인트 생성. */
	createVersion: (orgId: string, fileId: string, label?: string) => Promise<VersionListItem>;
	/** 버전 복원 (현재 본문을 그 버전으로 교체). */
	restoreVersion: (orgId: string, fileId: string, versionId: string) => Promise<void>;
	/** 수동 버전 삭제. */
	deleteVersion: (orgId: string, fileId: string, versionId: string) => Promise<void>;
	/** 복원 성공 후 해당 파일을 재하이드레이션 (서버 본문 반영). */
	onRestored: (orgId: string, fileId: string, filePath: string) => void;
	/** 현재 파일을 외부 공유 링크로 만든다. */
	openShare: (orgId: string, fileId: string, filePath: string) => void;
	/** 현재 파일의 활성 공유를 관리한다. */
	openManageShares: (orgId: string, fileId: string) => void;
	/** 삭제된 파일 복구(휴지통) 모달을 연다 — 전체 조직 대상. */
	openTrash: () => void;
}

interface FileContext {
	orgId: string;
	fileId: string;
	filePath: string;
}

export class CollabSidebarView extends ItemView {
	private ctx: FileContext | null = null;
	private presenceUserIds: string[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private readonly callbacks: CollabSidebarCallbacks,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_COLLAB;
	}

	getDisplayText(): string {
		return "MayaSpace 협업";
	}

	getIcon(): string {
		return "users";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** main.ts가 파일 전환 시 호출 — 사이드바 컨텍스트 갱신 후 리프레시. */
	setFileContext(ctx: FileContext | null): void {
		this.ctx = ctx;
		this.presenceUserIds = [];
		this.refresh();
	}

	/** SSE presence.changed 수신 시 main.ts가 호출. */
	onPresenceChanged(orgId: string, fileId: string, userIds: string[]): void {
		if (!this.ctx || this.ctx.orgId !== orgId || this.ctx.fileId !== fileId) return;
		this.presenceUserIds = userIds;
		this.renderPresenceBadges();
	}

	/** SSE presence.changed 또는 acl 변경 시 main.ts가 호출 — 전체 리프레시. */
	refresh(): void {
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();

		const header = root.createDiv({ cls: "mayaspace-collab-header" });
		header.createEl("h4", { text: "MayaSpace 협업", cls: "mayaspace-collab-title" });
		this.renderToolbar(header);

		if (!this.ctx) {
			root.createEl("p", { text: "MayaSpace 파일을 열면 협업 정보가 표시됩니다.", cls: "mayaspace-collab-empty" });
			return;
		}

		this.renderMembersSection(root);
		this.renderHistorySection(root);
		this.renderVersionsSection(root);
	}

	/** 헤더 우측 빠른 작업 — 공유/공유관리는 열린 파일이 있을 때만 활성. 휴지통·새로고침은 항상. */
	private renderToolbar(parent: HTMLElement): void {
		const toolbar = parent.createDiv({ cls: "mayaspace-collab-toolbar" });
		const hasFile = !!this.ctx;

		this.addToolButton(toolbar, "share-2", "공유 링크 만들기", hasFile, () => {
			if (this.ctx) this.callbacks.openShare(this.ctx.orgId, this.ctx.fileId, this.ctx.filePath);
		});
		this.addToolButton(toolbar, "link", "공유 관리", hasFile, () => {
			if (this.ctx) this.callbacks.openManageShares(this.ctx.orgId, this.ctx.fileId);
		});
		this.addToolButton(toolbar, "trash-2", "삭제된 파일 복구", true, () => this.callbacks.openTrash());
		this.addToolButton(toolbar, "refresh-cw", "새로고침", true, () => this.refresh());
	}

	private addToolButton(parent: HTMLElement, icon: string, tooltip: string, enabled: boolean, onClick: () => void): void {
		const btn = parent.createEl("button", { cls: "mayaspace-collab-tool clickable-icon" });
		setIcon(btn, icon);
		btn.setAttr("aria-label", tooltip);
		btn.title = tooltip;
		btn.disabled = !enabled;
		btn.onclick = onClick;
	}

	private renderMembersSection(root: HTMLElement): void {
		const section = root.createDiv({ cls: "mayaspace-collab-section" });
		section.createEl("h5", { text: "파일 접근자" });

		const container = section.createDiv({ cls: "mayaspace-collab-members" });
		container.createEl("p", { text: "로딩 중...", cls: "mayaspace-collab-loading" });

		const { orgId, fileId } = this.ctx!;
		Promise.all([
			this.callbacks.getAccessSummary(orgId, fileId),
			this.callbacks.getPresence(orgId, fileId),
		]).then(([members, presenceIds]) => {
			this.presenceUserIds = presenceIds;
			container.empty();
			if (members.length === 0) {
				container.createEl("p", { text: "접근 가능한 멤버 없음" });
				return;
			}
			const myEmail = this.callbacks.getMyEmail();
			for (const m of members) {
				this.renderMemberRow(container, m, myEmail);
			}
		}).catch(() => {
			container.empty();
			container.createEl("p", { text: "멤버 정보 로드 실패", cls: "mayaspace-collab-error" });
		});
	}

	private renderMemberRow(parent: HTMLElement, m: FileAccessMember, myEmail: string | null): void {
		const row = parent.createDiv({ cls: "mayaspace-collab-member-row" });

		const isMe = myEmail && m.email === myEmail;
		const isOnline = this.presenceUserIds.includes(m.userId);

		const badge = row.createSpan({ cls: `mayaspace-collab-presence-dot ${isOnline ? "online" : "offline"}` });
		badge.title = isOnline ? "지금 편집 중" : "오프라인";

		const label = row.createSpan({ cls: "mayaspace-collab-member-label" });
		label.setText(`${m.email}${isMe ? " (나)" : ""}`);

		const permLabel = row.createSpan({ cls: "mayaspace-collab-perm-label" });
		permLabel.setText(describePerms(m.effectivePermissions));
	}

	private renderPresenceBadges(): void {
		// presence dot 상태만 갱신 — 전체 re-render 없이 dot class만 교체한다.
		const rows = this.contentEl.querySelectorAll<HTMLElement>(".mayaspace-collab-member-row");
		for (const row of Array.from(rows)) {
			const dot = row.querySelector<HTMLElement>(".mayaspace-collab-presence-dot");
			const label = row.querySelector<HTMLElement>(".mayaspace-collab-member-label");
			if (!dot || !label) continue;
			// userId를 DOM에서 직접 읽기 어려우므로 전체 리프레시. 멤버 수가 적으므로 성능 무관.
		}
		// 간단하게 전체 리프레시
		this.render();
	}

	private renderHistorySection(root: HTMLElement): void {
		const section = root.createDiv({ cls: "mayaspace-collab-section" });
		section.createEl("h5", { text: "업데이트 이력" });

		const container = section.createDiv({ cls: "mayaspace-collab-history" });
		container.createEl("p", { text: "로딩 중...", cls: "mayaspace-collab-loading" });

		const { orgId, fileId } = this.ctx!;
		this.callbacks.getHistory(orgId, fileId).then((entries) => {
			container.empty();
			if (entries.length === 0) {
				container.createEl("p", { text: "이력 없음" });
				return;
			}
			for (const entry of entries) {
				this.renderHistoryEntry(container, entry);
			}
		}).catch(() => {
			container.empty();
			container.createEl("p", { text: "이력 로드 실패", cls: "mayaspace-collab-error" });
		});
	}

	private renderHistoryEntry(parent: HTMLElement, entry: FileHistoryEntry): void {
		const row = parent.createDiv({ cls: "mayaspace-collab-history-row" });

		const ts = row.createSpan({ cls: "mayaspace-collab-history-ts" });
		ts.setText(formatDate(entry.createdAt));

		const who = row.createSpan({ cls: "mayaspace-collab-history-who" });
		who.setText(entry.userId ? entry.userId.slice(0, 8) : "unknown");

		const action = row.createSpan({ cls: "mayaspace-collab-history-action" });
		action.setText(describeAction(entry.action, entry.meta));
	}

	// ---------- 버전 (타임머신) ----------

	private renderVersionsSection(root: HTMLElement): void {
		const section = root.createDiv({ cls: "mayaspace-collab-section mayaspace-versions" });

		const header = section.createDiv({ cls: "mayaspace-versions-header" });
		header.createEl("h5", { text: "버전" });
		const saveBtn = header.createEl("button", { text: "버전 저장", cls: "mayaspace-versions-save" });
		saveBtn.onclick = () => this.promptCreateVersion();

		const timeline = section.createDiv({ cls: "mayaspace-versions-timeline" });
		timeline.createEl("p", { text: "로딩 중...", cls: "mayaspace-collab-loading" });

		// 미리보기/diff 패널은 행 클릭 시 채워진다.
		section.createDiv({ cls: "mayaspace-versions-preview" });

		const { orgId, fileId } = this.ctx!;
		this.callbacks.listVersions(orgId, fileId).then((versions) => {
			timeline.empty();
			if (versions.length === 0) {
				timeline.createEl("p", { text: "저장된 버전 없음" });
				return;
			}
			for (const v of versions) {
				this.renderVersionRow(timeline, versions, v);
			}
		}).catch(() => {
			timeline.empty();
			timeline.createEl("p", { text: "버전 로드 실패", cls: "mayaspace-collab-error" });
		});
	}

	private renderVersionRow(parent: HTMLElement, all: VersionListItem[], v: VersionListItem): void {
		const row = parent.createDiv({ cls: "mayaspace-versions-row" });

		const ts = row.createSpan({ cls: "mayaspace-versions-ts" });
		ts.setText(formatDate(v.createdAt));

		const badge = row.createSpan({ cls: `mayaspace-versions-badge kind-${v.kind}` });
		badge.setText(describeKind(v.kind));

		if (v.label) {
			const label = row.createSpan({ cls: "mayaspace-versions-label" });
			label.setText(v.label);
		}

		const initials = row.createSpan({ cls: "mayaspace-versions-initials" });
		initials.setText(contributorInitials(v));

		row.onclick = () => this.openVersionPreview(all, v);
	}

	private async promptCreateVersion(): Promise<void> {
		if (!this.ctx) return;
		const { orgId, fileId } = this.ctx;
		const label = await promptLabel(this.app, "버전 저장", "라벨 (선택)");
		if (label === null) return; // 취소
		try {
			await this.callbacks.createVersion(orgId, fileId, label || undefined);
			this.render();
		} catch {
			this.render();
		}
	}

	private async openVersionPreview(all: VersionListItem[], v: VersionListItem): Promise<void> {
		if (!this.ctx) return;
		const panel = this.contentEl.querySelector<HTMLElement>(".mayaspace-versions-preview");
		if (!panel) return;
		const { orgId, fileId, filePath } = this.ctx;

		panel.empty();
		panel.createEl("p", { text: "본문 로딩 중...", cls: "mayaspace-collab-loading" });

		let content: string;
		try {
			content = (await this.callbacks.getVersion(orgId, fileId, v.id)).content;
		} catch {
			panel.empty();
			panel.createEl("p", { text: "버전 본문 로드 실패", cls: "mayaspace-collab-error" });
			return;
		}

		panel.empty();
		const toolbar = panel.createDiv({ cls: "mayaspace-versions-preview-toolbar" });

		const body = panel.createDiv({ cls: "mayaspace-versions-preview-body" });
		this.renderMarkdown(body, content, filePath);

		const diffBtn = toolbar.createEl("button", { text: "변경점 보기" });
		let showingDiff = false;
		diffBtn.onclick = () => {
			showingDiff = !showingDiff;
			diffBtn.setText(showingDiff ? "본문 보기" : "변경점 보기");
			body.empty();
			if (showingDiff) {
				const prev = previousVersion(all, v);
				void this.renderDiff(body, prev, orgId, fileId, content);
			} else {
				this.renderMarkdown(body, content, filePath);
			}
		};

		const restoreBtn = toolbar.createEl("button", { text: "이 버전으로 복원", cls: "mod-cta" });
		restoreBtn.onclick = () => this.confirmRestore(v);

		if (v.kind === "manual") {
			const deleteBtn = toolbar.createEl("button", { text: "삭제", cls: "mod-warning" });
			deleteBtn.onclick = () => this.confirmDelete(v);
		}
	}

	private renderMarkdown(el: HTMLElement, markdown: string, sourcePath: string): void {
		// MarkdownRenderer.render는 Obsidian의 안전한 렌더러를 거친다 (innerHTML 직접 주입 금지).
		void MarkdownRenderer.render(this.app, markdown, el, sourcePath, this);
	}

	private async renderDiff(
		el: HTMLElement,
		prev: VersionListItem | null,
		orgId: string,
		fileId: string,
		currentContent: string,
	): Promise<void> {
		const oldContent = prev
			? (await this.callbacks.getVersion(orgId, fileId, prev.id).then((c) => c.content).catch(() => ""))
			: "";

		// GitHub식 통합 diff: 줄번호 gutter + 단어강조 + 변경 없는 구간 접기.
		const segments = collapseRows(diffRows(oldContent, currentContent), 3);
		const expanded = new Set<number>();

		const paint = (): void => {
			el.empty();
			const table = el.createDiv({ cls: "mayaspace-versions-diff" });
			segments.forEach((seg, idx) => {
				if (seg.kind === "collapsed" && !expanded.has(idx)) {
					const marker = table.createDiv({ cls: "diff-row diff-collapsed" });
					marker.setText(`⋯ ${seg.rows.length}줄 동일 — 펼치기`);
					marker.onclick = () => {
						expanded.add(idx);
						paint();
					};
					return;
				}
				this.renderDiffRows(table, seg.rows);
			});
		};

		paint();
	}

	/** 한 세그먼트의 행들을 렌더. 변경 블록은 del/add를 짝지어 단어 강조한다. */
	private renderDiffRows(table: HTMLElement, rows: DiffRow[]): void {
		let i = 0;
		while (i < rows.length) {
			if (rows[i].type === "same") {
				this.renderDiffRow(table, rows[i], null);
				i++;
				continue;
			}
			let m = i;
			while (m < rows.length && rows[m].type !== "same") m++;
			const block = rows.slice(i, m);
			const dels = block.filter((r) => r.type === "del");
			const adds = block.filter((r) => r.type === "add");
			dels.forEach((d, k) =>
				this.renderDiffRow(table, d, adds[k] ? diffWords(d.text, adds[k].text).a : null),
			);
			adds.forEach((a, k) =>
				this.renderDiffRow(table, a, dels[k] ? diffWords(dels[k].text, a.text).b : null),
			);
			i = m;
		}
	}

	private renderDiffRow(table: HTMLElement, row: DiffRow, parts: WordPart[] | null): void {
		const rowEl = table.createDiv({ cls: `diff-row diff-${row.type}` });
		rowEl.createSpan({ cls: "diff-gutter", text: row.oldNo?.toString() ?? "" });
		rowEl.createSpan({ cls: "diff-gutter", text: row.newNo?.toString() ?? "" });
		const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
		rowEl.createSpan({ cls: "diff-sign", text: sign });
		const content = rowEl.createSpan({ cls: "diff-content" });
		if (parts) {
			// 모두 textContent 경유 — innerHTML 미사용(XSS 안전).
			for (const p of parts) {
				if (p.changed) content.createSpan({ cls: "diff-word", text: p.text });
				else content.appendText(p.text);
			}
		} else {
			content.setText(row.text);
		}
	}

	private confirmRestore(v: VersionListItem): void {
		if (!this.ctx) return;
		const { orgId, fileId, filePath } = this.ctx;
		const message = `${formatDate(v.createdAt)} 버전으로 현재 본문을 교체합니다. 계속할까요?`;
		new ConfirmModal(this.app, "버전 복원", message, async () => {
			await this.callbacks.restoreVersion(orgId, fileId, v.id);
			this.callbacks.onRestored(orgId, fileId, filePath);
			this.render();
		}).open();
	}

	private confirmDelete(v: VersionListItem): void {
		if (!this.ctx) return;
		const { orgId, fileId } = this.ctx;
		const message = `${formatDate(v.createdAt)} 수동 버전을 삭제합니다. 계속할까요?`;
		new ConfirmModal(this.app, "버전 삭제", message, async () => {
			await this.callbacks.deleteVersion(orgId, fileId, v.id);
			this.render();
		}).open();
	}
}

function describeKind(kind: VersionListItem["kind"]): string {
	switch (kind) {
		case "manual": return "수동";
		case "auto_periodic": return "주기";
		case "auto_session": return "자동";
		default: return kind;
	}
}

function contributorInitials(v: VersionListItem): string {
	const people = v.contributors.length > 0 ? v.contributors : v.createdBy ? [v.createdBy] : [];
	const initials = people
		.map((p) => (p.name ?? "?").trim().charAt(0).toUpperCase() || "?")
		.slice(0, 3);
	return initials.join(" ");
}

/** all은 최신순. v 바로 다음(더 오래된) 버전을 직전 버전으로 본다. */
function previousVersion(all: VersionListItem[], v: VersionListItem): VersionListItem | null {
	const idx = all.findIndex((x) => x.id === v.id);
	if (idx < 0 || idx + 1 >= all.length) return null;
	return all[idx + 1];
}

/** 라벨 입력 모달. 확인 시 입력값(빈 문자열 가능), 취소 시 null. */
function promptLabel(app: import("obsidian").App, title: string, placeholder: string): Promise<string | null> {
	return new Promise((resolve) => {
		new LabelPromptModal(app, title, placeholder, resolve).open();
	});
}

class LabelPromptModal extends Modal {
	private value = "";
	private settled = false;

	constructor(
		app: import("obsidian").App,
		private readonly titleText: string,
		private readonly placeholder: string,
		private readonly onDone: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.titleText);
		const input = this.contentEl.createEl("input", { type: "text" });
		input.placeholder = this.placeholder;
		input.oninput = () => { this.value = input.value; };
		input.onkeydown = (e) => { if (e.key === "Enter") this.finish(this.value); };

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const ok = buttons.createEl("button", { text: "저장", cls: "mod-cta" });
		ok.onclick = () => this.finish(this.value);
		const cancel = buttons.createEl("button", { text: "취소" });
		cancel.onclick = () => this.finish(null);

		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish(null); // X로 닫아도 취소로 처리
	}

	private finish(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.onDone(value);
		this.close();
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: import("obsidian").App,
		private readonly titleText: string,
		private readonly message: string,
		private readonly onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.titleText);
		this.contentEl.createEl("p", { text: this.message });

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const confirm = buttons.createEl("button", { text: "확인", cls: "mod-cta" });
		confirm.onclick = async () => {
			confirm.disabled = true;
			try { await this.onConfirm(); }
			finally { this.close(); }
		};
		const cancel = buttons.createEl("button", { text: "취소" });
		cancel.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function describePerms(bits: number): string {
	const READ = 1, UPDATE = 2, CREATE = 4, DELETE = 8, SHARE = 16;
	if ((bits & (READ | UPDATE | CREATE | DELETE | SHARE)) === (READ | UPDATE | CREATE | DELETE | SHARE)) return "소유자";
	if (bits & (UPDATE | CREATE | DELETE)) return "편집자";
	if (bits & READ) return "조회자";
	return "없음";
}

function describeAction(action: string, meta: Record<string, unknown> | null): string {
	switch (action) {
		case "edit": return "편집";
		case "create": return "생성";
		case "delete": return "삭제";
		case "move": return meta ? `이동 ${meta["from"]} → ${meta["to"]}` : "이동";
		case "acl_changed": return "권한 변경";
		default: return action;
	}
}

function formatDate(iso: string): string {
	const d = new Date(iso);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
