/**
 * MayaSpace Hocuspocus provider wrapper.
 *
 * Each (orgId, fileId) maps to a unique doc name:
 *   `org:{orgId}:file:{fileId}`
 *
 * Owns the Y.Doc lifecycle: Hocuspocus creates and destroys the doc.
 * The Obsidian editor binding consumes `handle.doc` and `handle.awareness`.
 *
 * Provider creation is factory-injected so unit tests don't depend on a real
 * WebSocket. The default factory creates a real HocuspocusProvider; tests
 * pass a mock factory.
 */

import * as Y from "yjs";
import type { MayaspaceAuth } from "../auth/mayaspace-auth";

// When the server can't be reached, bind on the IndexedDB snapshot this long
// after it replays rather than blocking collaboration until a socket appears.
const OFFLINE_BIND_GRACE_MS = 2500;

export interface ProviderHandle {
	doc: Y.Doc;
	awareness: any;
	destroy(): void;
	/**
	 * Resolves once the provider's initial sync settles: the Hocuspocus server
	 * sync when online, or the IndexedDB snapshot (after a short grace) when the
	 * server is unreachable. The editor binding waits on this so it never seeds
	 * an empty ytext from the editor body and doubles the document.
	 */
	whenSynced: Promise<void>;
}

export type ProviderStatus = "connecting" | "connected" | "disconnected";

export interface ProviderFactoryArgs {
	url: string;
	name: string;
	/**
	 * Token provider, not a fixed string: HocuspocusProvider calls it on every
	 * (re)connection, so a reconnect after the access token expires gets a fresh
	 * (auto-refreshed) token instead of retrying forever with a dead one.
	 */
	getToken: () => Promise<string>;
	onStatus?: (s: ProviderStatus) => void;
	onAuthFailure?: () => void;
}

export type ProviderFactory = (args: ProviderFactoryArgs) => ProviderHandle;

interface OpenEntry {
	orgId: string;
	fileId: string;
	handle: ProviderHandle;
	refCount: number;
}

type PermissionLostListener = (info: { orgId: string; fileId: string }) => void;
type StatusListener = (info: { orgId: string; fileId: string; status: ProviderStatus }) => void;

export class MayaspaceSync {
	private entries = new Map<string, OpenEntry>();
	// In-flight purges keyed by doc. openDoc awaits these so a re-open never
	// races the IndexedDB delete on the same store name.
	private purges = new Map<string, Promise<void>>();
	private permissionLostListeners: PermissionLostListener[] = [];
	private statusListeners: StatusListener[] = [];

	constructor(
		private wsUrl: string,
		private auth: MayaspaceAuth,
		private factory: ProviderFactory,
	) {}

	async openDoc(orgId: string, fileId: string): Promise<ProviderHandle> {
		const key = entryKey(orgId, fileId);
		// If a purge (IndexedDB delete) is in flight for this doc, wait for it to
		// finish before opening a fresh provider. Otherwise the delete races the
		// new IndexeddbPersistence on the same store name → "database connection
		// is closing" and a half-synced session (the rename/revoke→reopen bug).
		const pendingPurge = this.purges.get(key);
		if (pendingPurge) await pendingPurge.catch(() => undefined);

		const existing = this.entries.get(key);
		if (existing) {
			existing.refCount += 1;
			return existing.handle;
		}

		const handle = this.factory({
			url: this.wsUrl,
			name: docName(orgId, fileId),
			getToken: () => this.auth.getValidAccessToken(),
			onStatus: (status) => {
				for (const l of this.statusListeners) l({ orgId, fileId, status });
			},
			onAuthFailure: () => {
				this.dropEntry(key);
				for (const l of this.permissionLostListeners) l({ orgId, fileId });
			},
		});

		this.entries.set(key, { orgId, fileId, handle, refCount: 1 });
		console.log(`[mayaspace] openDoc → ${docName(orgId, fileId)} via ${this.wsUrl}`);
		return handle;
	}

	async closeDoc(orgId: string, fileId: string): Promise<void> {
		const key = entryKey(orgId, fileId);
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.refCount -= 1;
		if (entry.refCount > 0) return;
		entry.handle.destroy();
		this.entries.delete(key);
	}

	async closeAll(): Promise<void> {
		for (const entry of Array.from(this.entries.values())) {
			entry.handle.destroy();
		}
		this.entries.clear();
	}

	/**
	 * Drop any live provider for this doc AND delete its on-disk IndexedDB
	 * store. closeDoc only destroys the in-memory provider/persistence; the
	 * persisted snapshot lingers, so document content survives logout / READ
	 * revocation / delete locally. Call this on those paths so revoked content
	 * doesn't stay cached on the device.
	 */
	async purgeDoc(orgId: string, fileId: string): Promise<void> {
		const key = entryKey(orgId, fileId);
		const name = docName(orgId, fileId);
		this.dropEntry(key);
		// Track the delete so a concurrent openDoc for the same doc waits for it
		// to complete instead of opening a persistence on a store being deleted.
		const p = deleteIndexedDb(name);
		this.purges.set(key, p);
		try {
			await p;
		} finally {
			if (this.purges.get(key) === p) this.purges.delete(key);
		}
	}

	isOpen(orgId: string, fileId: string): boolean {
		return this.entries.has(entryKey(orgId, fileId));
	}

	onPermissionLost(listener: PermissionLostListener): () => void {
		this.permissionLostListeners.push(listener);
		return () => {
			const i = this.permissionLostListeners.indexOf(listener);
			if (i >= 0) this.permissionLostListeners.splice(i, 1);
		};
	}

	onStatus(listener: StatusListener): () => void {
		this.statusListeners.push(listener);
		return () => {
			const i = this.statusListeners.indexOf(listener);
			if (i >= 0) this.statusListeners.splice(i, 1);
		};
	}

	private dropEntry(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		try { entry.handle.destroy(); } catch { /* already destroyed */ }
		this.entries.delete(key);
	}
}

function docName(orgId: string, fileId: string): string {
	return `org:${orgId}:file:${fileId}`;
}

// IndexeddbPersistence opens one IndexedDB database per doc name, so deleting
// that database removes the persisted Y.Doc snapshot. The provider/persistence
// must be destroyed first (done by the caller) or the delete blocks on the
// open connection.
function deleteIndexedDb(name: string): Promise<void> {
	return new Promise((resolve) => {
		let req: IDBOpenDBRequest;
		try {
			req = indexedDB.deleteDatabase(name);
		} catch {
			resolve();
			return;
		}
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}

function entryKey(orgId: string, fileId: string): string {
	return `${orgId}:${fileId}`;
}

/**
 * Default factory that creates a real HocuspocusProvider backed by
 * IndexedDB persistence.
 *
 * IndexeddbPersistence keeps the Y.Doc on disk per-document (keyed by the
 * Hocuspocus doc name = `org:{orgId}:file:{fileId}`). That makes offline
 * edits survive Obsidian restarts and plugin reloads: when the plugin
 * loads again, the same doc name re-opens its IndexedDB store, replays
 * the saved updates into the new Y.Doc, and once the WebSocket reconnects
 * Hocuspocus performs a normal CRDT sync — local and remote changes
 * merge deterministically without overwriting either side.
 *
 * Without this, the previous flow was: offline edit → ytext in memory →
 * Obsidian/plugin restart → in-memory ytext gone → reconnect → ytext seeded
 * from the server's old state → reconcile to vault.md wipes the user's
 * offline edits. With IndexedDB the ytext arrives at reconcile time
 * already containing the user's offline changes.
 */
export function defaultHocuspocusFactory(): ProviderFactory {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { HocuspocusProvider } = require("@hocuspocus/provider");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { IndexeddbPersistence } = require("y-indexeddb");

	return ({ url, name, getToken, onStatus, onAuthFailure }) => {
		const provider = new HocuspocusProvider({
			url,
			name,
			// 함수를 그대로 넘긴다 — provider가 매 (재)연결마다 호출해 새 토큰을 받는다.
			token: getToken,
			onStatus: (data: { status: ProviderStatus }) => onStatus?.(data.status),
			onAuthenticationFailed: () => onAuthFailure?.(),
		});
		// Same doc name → same IndexedDB store. Survives Obsidian quit /
		// plugin reload / device sleep, then CRDT-merges with the server on
		// the next WebSocket sync.
		const persistence = new IndexeddbPersistence(name, provider.document);

		// Settle once the doc's content is the real merged truth, so the editor
		// binding never seeds an empty ytext from the editor body (which doubles
		// the document on the next sync). Online: the Hocuspocus `synced` event.
		// Offline / unreachable server: fall back to the IndexedDB snapshot after
		// a short grace, so editing isn't blocked forever when there's no socket.
		const whenSynced = new Promise<void>((resolve) => {
			let settled = false;
			const settle = () => { if (!settled) { settled = true; resolve(); } };
			if (provider.synced) { settle(); return; }
			provider.on("synced", settle);
			persistence.on("synced", () => {
				console.log("[mayaspace] IndexedDB synced", name, "ytext.length=", provider.document.getText("content").length);
				setTimeout(settle, OFFLINE_BIND_GRACE_MS);
			});
		});

		return {
			doc: provider.document,
			awareness: provider.awareness,
			whenSynced,
			destroy: () => {
				try { persistence.destroy(); } catch { /* already gone */ }
				provider.destroy();
			},
		};
	};
}
