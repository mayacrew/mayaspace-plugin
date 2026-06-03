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

import { ItemView, WorkspaceLeaf } from "obsidian";
import type { FileAccessMember, FileHistoryEntry } from "../api/mayaspace-api";

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
		root.createEl("h4", { text: "MayaSpace 협업" });

		if (!this.ctx) {
			root.createEl("p", { text: "MayaSpace 파일을 열면 협업 정보가 표시됩니다.", cls: "mayaspace-collab-empty" });
			return;
		}

		this.renderMembersSection(root);
		this.renderHistorySection(root);
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
