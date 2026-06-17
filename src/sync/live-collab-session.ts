/**
 * Per-file live-collab session lifecycle.
 *
 * attach(path, mapping):
 *   1) sync.openDoc starts a Hocuspocus session (server seeds Y.Doc from .yjs or .md)
 *   2) If an EditorView is already mounted for `path`, bind yCollab via Compartment
 *
 * detach(path):
 *   - unbind the editor extension (if bound), close the Hocuspocus session
 *
 * If the EditorView is not yet mounted (preview mode etc.), attach still
 * succeeds. When `active-leaf-change` / `layout-change` fires later, the
 * main plugin calls ensureBoundForAllActive() to re-bind.
 */

import type * as Y from "yjs";

export interface ApiLike {
	readFile(orgId: string, fileId: string): Promise<{ content: string }>;
}

export interface ProviderHandleLike {
	doc: Y.Doc;
	awareness: unknown;
	destroy(): void;
	/**
	 * Resolves once the provider's initial sync settles (server sync when
	 * online, IndexedDB snapshot when offline). Binding before this leaves the
	 * Y.Doc transiently empty and makes bindYCollab seed the editor body into
	 * ytext, which doubles when the real content syncs in. Optional so test
	 * mocks can omit it (treated as already-synced).
	 */
	whenSynced?: Promise<void>;
}

export interface SyncLike {
	openDoc(orgId: string, fileId: string): Promise<ProviderHandleLike>;
	closeDoc(orgId: string, fileId: string): Promise<void>;
	onPermissionLost(cb: (info: { orgId: string; fileId: string }) => void): () => void;
}

export interface SessionDeps {
	api: ApiLike;
	sync: SyncLike;
	/**
	 * Bind yCollab to the editor view. Returns an unbind function.
	 * readOnly=true binds the editor non-editable (사용자 입력 차단) while still
	 * receiving remote updates — used when the user has READ but not UPDATE.
	 */
	bindEditor: (view: unknown, handle: ProviderHandleLike, readOnly?: boolean) => () => void;
	/** Look up the active EditorView for `path` — null if not mounted. */
	findEditorView: (path: string) => unknown | null;
	/**
	 * Called on detach with the final ytext content. The caller writes it to
	 * the vault placeholder so Obsidian's search / graph reflect the latest
	 * version after the live session ends.
	 */
	dumpContent?: (path: string, content: string) => Promise<void> | void;
}

interface ActiveEntry {
	orgId: string;
	fileId: string;
	handle: ProviderHandleLike;
	unbind: (() => void) | null;
	boundView: unknown | null;
}

export class LiveCollabSession {
	private active = new Map<string, ActiveEntry>();
	private pending = new Map<string, Promise<void>>();

	constructor(private deps: SessionDeps) {}

	async attach(
		path: string,
		mapping: { orgId: string; fileId: string },
		opts: { readOnly?: boolean } = {},
	): Promise<void> {
		console.log("[mayaspace] attach()", path, "fileId=", mapping.fileId, "readOnly=", !!opts.readOnly);
		if (this.active.has(path)) {
			console.log("[mayaspace] attach() skip — already active", path);
			return;
		}
		const inflight = this.pending.get(path);
		if (inflight) return inflight;

		const p = this.doAttach(path, mapping, opts).finally(() => this.pending.delete(path));
		this.pending.set(path, p);
		return p;
	}

	private async doAttach(
		path: string,
		mapping: { orgId: string; fileId: string },
		opts: { readOnly?: boolean },
	): Promise<void> {
		// ytext is the ground truth. The server seeds it from the .yjs binary or
		// from the markdown body on first open; we let yCollab render it to the
		// editor instead of overwriting the placeholder via vault.modify (which
		// caused content doubling and parent-null panics in earlier iterations).
		const handle = await this.deps.sync.openDoc(mapping.orgId, mapping.fileId);

		// Wait for the provider's initial sync before binding. Binding while the
		// Y.Doc is still empty makes bindYCollab take its "CRDT empty → seed
		// editor body into ytext" branch; the real content then syncs in and
		// merges, doubling the document on every reattach. After sync, ytext
		// holds the true content so the binder reconciles ytext → editor instead.
		if (handle.whenSynced) {
			try {
				await handle.whenSynced;
			} catch {
				/* sync failed — bind on whatever local state we have */
			}
		}

		let unbind: (() => void) | null = null;
		const view = this.deps.findEditorView(path);
		if (view) {
			unbind = this.deps.bindEditor(view, handle, opts.readOnly ?? false);
		}

		this.active.set(path, {
			orgId: mapping.orgId,
			fileId: mapping.fileId,
			handle,
			unbind,
			boundView: view ?? null,
		});
	}

	async detach(path: string): Promise<void> {
		console.log("[mayaspace] detach()", path);
		const inflight = this.pending.get(path);
		if (inflight) {
			try { await inflight; } catch { /* attach failed; nothing active */ }
		}
		const entry = this.active.get(path);
		if (!entry) {
			console.log("[mayaspace] detach() skip — no entry", path);
			return;
		}

		// Dump the live ytext to the vault placeholder before closing. This
		// lets Obsidian search / graph see the latest content once the live
		// session is gone, without us reading from the server again.
		if (this.deps.dumpContent) {
			try {
				const content = (entry.handle.doc as any).getText("content").toString() as string;
				await this.deps.dumpContent(path, content);
			} catch (e) {
				console.warn("[mayaspace] dumpContent failed", path, e);
			}
		}

		try {
			entry.unbind?.();
		} catch {
			/* binding may have already released on view destroy */
		}
		try {
			await this.deps.sync.closeDoc(entry.orgId, entry.fileId);
		} finally {
			this.active.delete(path);
		}
	}

	async detachAll(): Promise<void> {
		for (const path of Array.from(this.active.keys())) {
			await this.detach(path);
		}
	}

	/**
	 * Rebind to the EditorView currently shown to the user.
	 *
	 * Obsidian recreates the EditorView on mode switches (source ↔ reading)
	 * and on leaf moves. If we keep the original binding, the user's *new*
	 * view has no yCollab — ytext updates won't render and edits won't
	 * propagate. So compare the found view against the bound one and rebind
	 * whenever it differs. Cheap when nothing changed (identity check skips).
	 */
	ensureBoundForAllActive(): void {
		for (const [path, entry] of this.active) {
			const view = this.deps.findEditorView(path);
			if (entry.boundView === view) continue;
			if (!view) {
				// Obsidian fires layout-change / active-leaf-change while it is
				// still in the middle of replacing leaves and editor states.
				// During that window findEditorView returns null for a file the
				// user has not actually closed. Tearing down the binding here
				// is the symptom users see as "sync broke": B's editor stays
				// silent even when ytext receives A's updates.
				// Keep the binding, wait for the next event. If the file is
				// really gone, the next event will find a different view (or
				// the user closing it triggers an explicit detach elsewhere).
				console.log("[mayaspace] ensureBound: view transiently missing — keeping bind", path);
				continue;
			}
			console.log("[mayaspace] ensureBound: rebinding to new view", path);
			if (entry.unbind) {
				try { entry.unbind(); } catch { /* old view destroyed */ }
				entry.unbind = null;
			}
			entry.boundView = view;
			entry.unbind = this.deps.bindEditor(view, entry.handle);
		}
	}

	activePaths(): string[] {
		return Array.from(this.active.keys());
	}

	/**
	 * The live provider handle for `path` — null if no session is active.
	 * Lets the vault-modify handler merge an external disk write into the
	 * SAME Y.Doc yCollab is bound to (so it reaches the editor + peers),
	 * instead of skipping the change.
	 */
	handleFor(path: string): ProviderHandleLike | null {
		return this.active.get(path)?.handle ?? null;
	}

	pathFor(orgId: string, fileId: string): string | null {
		for (const [path, entry] of this.active) {
			if (entry.orgId === orgId && entry.fileId === fileId) return path;
		}
		return null;
	}
}
