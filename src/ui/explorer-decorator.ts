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

export type SyncStatus = "idle" | "syncing" | "connected" | "conflict" | "offline";

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

		const desired = new Set(this.state.getOrgFilePaths());
		const statuses = this.state.getStatuses();

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
		const item = view?.fileItems?.[path];
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
