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
 * Accessing `fileItems` requires reaching into Obsidian internals — the same
 * pattern peerdraft uses. It can break across Obsidian releases; the
 * decorator is defensive and skips silently if the shape is unexpected.
 */

import type { App } from "obsidian";
import { ancestorFolders, deriveFolderStatuses, type SyncStatus } from "../lib/folder-status";

// SyncStatus는 lib/folder-status가 소유한다. 기존 import 호환을 위해 여기서 re-export.
export type { SyncStatus };

const CSS_ORG_FILE = "mayaspace-org-file";
const CSS_STATUS_PREFIX = "mayaspace-status-";

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
}

export class ExplorerDecorator {
	private decoratedPaths = new Set<string>();
	private statusByPath = new Map<string, SyncStatus>();

	constructor(private app: App, private state: DecoratorState) {}

	refresh(): void {
		const view = this.findExplorerView();
		if (!view || !view.fileItems) return;

		// 파일에 더해 상위 폴더도 장식한다. 폴더 상태는 하위 파일들의 집계.
		const filePaths = this.state.getOrgFilePaths();
		const fileStatuses = this.state.getStatuses();
		const folderStatuses = deriveFolderStatuses(filePaths, fileStatuses);

		const desired = new Set<string>(filePaths);
		for (const folder of Object.keys(folderStatuses)) desired.add(folder);
		const statuses: Record<string, SyncStatus> = { ...fileStatuses, ...folderStatuses };

		// Add classes to new paths
		for (const path of desired) {
			const item = view.fileItems[path];
			const el = item?.selfEl ?? item?.el;
			if (!el) continue;
			el.classList.add(CSS_ORG_FILE);
			this.applyStatus(el, path, statuses[path]);
		}

		// Remove classes from paths that left the org set
		for (const path of this.decoratedPaths) {
			if (desired.has(path)) continue;
			const item = view.fileItems[path];
			const el = item?.selfEl ?? item?.el;
			if (!el) continue;
			el.classList.remove(CSS_ORG_FILE);
			this.clearStatus(el);
		}

		this.decoratedPaths = desired;
		this.statusByPath = new Map(Object.entries(statuses));
	}

	updateStatus(path: string, status: SyncStatus): void {
		this.statusByPath.set(path, status);
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

	private applyStatusToPath(view: FileExplorerView, path: string, status: SyncStatus): void {
		const item = view.fileItems?.[path];
		const el = item?.selfEl ?? item?.el;
		if (!el) return;
		this.applyStatus(el, path, status);
	}

	clear(): void {
		const view = this.findExplorerView();
		for (const path of this.decoratedPaths) {
			const item = view?.fileItems?.[path];
			const el = item?.selfEl ?? item?.el;
			if (!el) continue;
			el.classList.remove(CSS_ORG_FILE);
			this.clearStatus(el);
		}
		this.decoratedPaths.clear();
		this.statusByPath.clear();
	}

	private applyStatus(el: HTMLElement, path: string, status: SyncStatus | undefined): void {
		this.clearStatus(el);
		const effective = status ?? "idle";
		el.classList.add(CSS_STATUS_PREFIX + effective);
	}

	private clearStatus(el: HTMLElement): void {
		const toRemove: string[] = [];
		el.classList.forEach((cls) => {
			if (cls.startsWith(CSS_STATUS_PREFIX)) toRemove.push(cls);
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
