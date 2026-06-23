/**
 * Decorate the Obsidian file explorer to mark mayaspace org files/folders.
 *
 * Strategy: do NOT mutate the DOM tree. Add CSS classes to the existing
 * `tree-item-self` elements via the file-explorer view's internal `fileItems`
 * map. Refresh on:
 *   - file-mappings change
 *   - vault.on('create' | 'rename' | 'delete')
 *   - sync status change
 *
 * Two orthogonal class dimensions per row:
 *   - mayaspace-status-<sync>    : live-collab connection (folder-status.ts)
 *   - mayaspace-content-<state>  : whether the body is local (content-status.ts)
 *
 * Accessing `fileItems` requires reaching into Obsidian internals — the same
 * pattern peerdraft uses. It can break across Obsidian releases; the
 * decorator is defensive and skips silently if the shape is unexpected.
 */

import type { App } from "obsidian";
import { ancestorFolders, deriveFolderStatuses, type SyncStatus } from "../lib/folder-status";
import { deriveFolderContentStates, type ContentState } from "../lib/content-status";

// 타입 소유는 lib에 있다. 기존 import 호환을 위해 여기서 re-export.
export type { SyncStatus };
export type { ContentState };

const CSS_ORG_FILE = "mayaspace-org-file";
const CSS_STATUS_PREFIX = "mayaspace-status-";
const CSS_CONTENT_PREFIX = "mayaspace-content-";

interface FileItem {
	el?: HTMLElement;
	selfEl?: HTMLElement;
}

interface FileExplorerView {
	fileItems?: Record<string, FileItem>;
}

export interface DecoratorState {
	getOrgFilePaths(): string[];
	getStatuses(): Record<string, SyncStatus>;
	getContentStates(): Record<string, ContentState>;
}

export class ExplorerDecorator {
	private decoratedPaths = new Set<string>();

	constructor(private app: App, private state: DecoratorState) {}

	refresh(): void {
		const view = this.findExplorerView();
		if (!view || !view.fileItems) return;

		// 파일에 더해 상위 폴더도 장식한다. 폴더 상태는 하위 파일들의 집계.
		const filePaths = this.state.getOrgFilePaths();
		const fileStatuses = this.state.getStatuses();
		const folderStatuses = deriveFolderStatuses(filePaths, fileStatuses);
		const fileContent = this.state.getContentStates();
		const folderContent = deriveFolderContentStates(filePaths, fileContent);

		const desired = new Set<string>(filePaths);
		for (const folder of Object.keys(folderStatuses)) desired.add(folder);
		const statuses: Record<string, SyncStatus> = { ...fileStatuses, ...folderStatuses };
		const contents: Record<string, ContentState> = { ...fileContent, ...folderContent };

		// Add classes to new paths
		for (const path of desired) {
			const el = this.elFor(view, path);
			if (!el) continue;
			el.classList.add(CSS_ORG_FILE);
			this.applyStatus(el, statuses[path]);
			this.applyContent(el, contents[path]);
		}

		// Remove classes from paths that left the org set
		for (const path of this.decoratedPaths) {
			if (desired.has(path)) continue;
			const el = this.elFor(view, path);
			if (!el) continue;
			el.classList.remove(CSS_ORG_FILE);
			this.clearStatus(el);
			this.clearContent(el);
		}

		this.decoratedPaths = desired;
	}

	updateStatus(path: string, status: SyncStatus): void {
		const view = this.findExplorerView();
		if (!view?.fileItems) return;

		this.applyStatusToPath(view, path, status);

		// 폴더 집계는 형제 파일들 상태에 의존하므로 전체에서 다시 계산해 조상 폴더에 반영한다.
		// 방금 보고된 status를 우선 반영(호출 순서에 무관하게 정확하도록).
		const merged = { ...this.state.getStatuses(), [path]: status };
		const folderStatuses = deriveFolderStatuses(this.state.getOrgFilePaths(), merged);
		for (const folder of ancestorFolders(path)) {
			const folderStatus = folderStatuses[folder];
			if (folderStatus !== undefined) this.applyStatusToPath(view, folder, folderStatus);
		}
	}

	updateContent(path: string, content: ContentState): void {
		const view = this.findExplorerView();
		if (!view?.fileItems) return;

		this.applyContentToPath(view, path, content);

		const merged = { ...this.state.getContentStates(), [path]: content };
		const folderContent = deriveFolderContentStates(this.state.getOrgFilePaths(), merged);
		for (const folder of ancestorFolders(path)) {
			const folderContent2 = folderContent[folder];
			if (folderContent2 !== undefined) this.applyContentToPath(view, folder, folderContent2);
		}
	}

	clear(): void {
		const view = this.findExplorerView();
		for (const path of this.decoratedPaths) {
			const el = this.elFor(view, path);
			if (!el) continue;
			el.classList.remove(CSS_ORG_FILE);
			this.clearStatus(el);
			this.clearContent(el);
		}
		this.decoratedPaths.clear();
	}

	private elFor(view: FileExplorerView | null, path: string): HTMLElement | null {
		const item = view?.fileItems?.[path];
		return item?.selfEl ?? item?.el ?? null;
	}

	private applyStatusToPath(view: FileExplorerView, path: string, status: SyncStatus): void {
		const el = this.elFor(view, path);
		if (el) this.applyStatus(el, status);
	}

	private applyContentToPath(view: FileExplorerView, path: string, content: ContentState): void {
		const el = this.elFor(view, path);
		if (el) this.applyContent(el, content);
	}

	private applyStatus(el: HTMLElement, status: SyncStatus | undefined): void {
		this.clearStatus(el);
		el.classList.add(CSS_STATUS_PREFIX + (status ?? "idle"));
	}

	private applyContent(el: HTMLElement, content: ContentState | undefined): void {
		this.clearContent(el);
		el.classList.add(CSS_CONTENT_PREFIX + (content ?? "placeholder"));
	}

	private clearStatus(el: HTMLElement): void {
		this.removePrefixed(el, CSS_STATUS_PREFIX);
	}

	private clearContent(el: HTMLElement): void {
		this.removePrefixed(el, CSS_CONTENT_PREFIX);
	}

	private removePrefixed(el: HTMLElement, prefix: string): void {
		const toRemove: string[] = [];
		el.classList.forEach((cls) => {
			if (cls.startsWith(prefix)) toRemove.push(cls);
		});
		for (const cls of toRemove) el.classList.remove(cls);
	}

	private findExplorerView(): FileExplorerView | null {
		const leaves = this.app.workspace.getLeavesOfType("file-explorer");
		if (!leaves || leaves.length === 0) return null;
		// Internal shape — guarded by optional chaining at call sites
		return leaves[0].view as unknown as FileExplorerView;
	}
}
