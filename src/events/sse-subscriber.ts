/**
 * Subscribe to per-org file event streams via SSE.
 *
 * GET /v1/orgs/:oid/events emits `file.created`, `file.deleted`, `file.moved`.
 * EventSource cannot send custom headers, so the JWT travels as `?token=`.
 *
 * Events originating from this device are filtered using `deviceId` in the
 * payload (matched against our own device id from the JWT).
 *
 * Handlers update the vault directly and the file-mappings store. The plugin
 * does NOT re-run the full tree sync per event.
 */

export interface FileCreatedEvent {
	orgId: string;
	fileId: string;
	path: string;
	deviceId: string | null;
}

export interface FileDeletedEvent {
	orgId: string;
	fileId: string;
	path: string;
	deviceId: string | null;
}

export interface FileMovedEvent {
	orgId: string;
	fileId: string;
	oldPath: string;
	newPath: string;
	deviceId: string | null;
}

export interface FileUpdatedEvent {
	orgId: string;
	fileId: string;
	path: string;
	deviceId: string | null;
}

export interface PresenceChangedEvent {
	orgId: string;
	fileId: string;
	userIds: string[];
}

export interface EventsHandlers {
	onCreated?: (p: FileCreatedEvent) => void | Promise<void>;
	onDeleted?: (p: FileDeletedEvent) => void | Promise<void>;
	onMoved?: (p: FileMovedEvent) => void | Promise<void>;
	onUpdated?: (p: FileUpdatedEvent) => void | Promise<void>;
	onPresenceChanged?: (p: PresenceChangedEvent) => void | Promise<void>;
	onError?: (orgId: string, e: unknown) => void;
}

export interface EventsClientOptions {
	restUrl: string;
	/**
	 * Token provider, not a fixed string. EventSource can't change its URL on
	 * reconnect, so we reconnect manually and call this each time to get a fresh
	 * (auto-refreshed) token — otherwise a reconnect after the access token
	 * expires retries forever with a dead token in the URL.
	 */
	getToken: () => Promise<string>;
	myDeviceId: string;
	handlers: EventsHandlers;
	/** EventSource constructor (test injection). Defaults to globalThis.EventSource. */
	eventSourceCtor?: typeof EventSource;
	/** Reconnect backoff bounds (test injection). */
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
}

interface OrgSubscription {
	source: EventSource | null;
	timer: ReturnType<typeof setTimeout> | null;
	attempt: number;
	closed: boolean;
}

export class MayaspaceEvents {
	private readonly subs = new Map<string, OrgSubscription>();
	private readonly Ctor: typeof EventSource;
	private readonly baseMs: number;
	private readonly maxMs: number;

	constructor(private readonly opts: EventsClientOptions) {
		this.Ctor = opts.eventSourceCtor ?? (globalThis as { EventSource: typeof EventSource }).EventSource;
		this.baseMs = opts.reconnectBaseMs ?? 1000;
		this.maxMs = opts.reconnectMaxMs ?? 30000;
	}

	subscribe(orgId: string): void {
		if (this.subs.has(orgId)) return;
		this.subs.set(orgId, { source: null, timer: null, attempt: 0, closed: false });
		void this.connect(orgId);
	}

	unsubscribe(orgId: string): void {
		const sub = this.subs.get(orgId);
		if (!sub) return;
		this.teardown(sub);
		this.subs.delete(orgId);
	}

	unsubscribeAll(): void {
		for (const sub of this.subs.values()) this.teardown(sub);
		this.subs.clear();
	}

	private teardown(sub: OrgSubscription): void {
		sub.closed = true;
		if (sub.timer) { clearTimeout(sub.timer); sub.timer = null; }
		if (sub.source) { sub.source.close(); sub.source = null; }
	}

	// 매 (재)연결마다 새 토큰을 받아 EventSource를 연다.
	private async connect(orgId: string): Promise<void> {
		const sub = this.subs.get(orgId);
		if (!sub || sub.closed) return;

		let token: string;
		try {
			token = await this.opts.getToken();
		} catch (err) {
			this.opts.handlers.onError?.(orgId, err);
			this.scheduleReconnect(orgId);
			return;
		}
		if (sub.closed) return;

		const url = `${this.opts.restUrl}/v1/orgs/${orgId}/events?token=${encodeURIComponent(token)}`;
		const es = new this.Ctor(url);
		sub.source = es;

		es.addEventListener("file.created", (e) => this.dispatch(orgId, e, "onCreated"));
		es.addEventListener("file.deleted", (e) => this.dispatch(orgId, e, "onDeleted"));
		es.addEventListener("file.moved", (e) => this.dispatch(orgId, e, "onMoved"));
		es.addEventListener("file.updated", (e) => this.dispatch(orgId, e, "onUpdated"));
		es.addEventListener("presence.changed", (e) => this.dispatchPresence(orgId, e));
		es.addEventListener("open", () => { const s = this.subs.get(orgId); if (s) s.attempt = 0; });
		es.addEventListener("error", (e) => {
			this.opts.handlers.onError?.(orgId, e);
			this.scheduleReconnect(orgId);
		});
	}

	// EventSource는 에러 시 스스로 (같은 죽은 토큰으로) 재시도하므로, 직접 닫고
	// 백오프 후 새 토큰으로 다시 연다. 에러는 연달아 올 수 있어 타이머를 겹치지 않는다.
	private scheduleReconnect(orgId: string): void {
		const sub = this.subs.get(orgId);
		if (!sub || sub.closed) return;
		if (sub.source) { sub.source.close(); sub.source = null; }
		if (sub.timer) return;
		const delay = Math.min(this.baseMs * 2 ** sub.attempt, this.maxMs);
		sub.attempt += 1;
		sub.timer = setTimeout(() => {
			sub.timer = null;
			void this.connect(orgId);
		}, delay);
	}

	private dispatch(orgId: string, e: Event, key: "onCreated" | "onDeleted" | "onMoved" | "onUpdated"): void {
		const me = (e as MessageEvent).data;
		let payload: { deviceId: string | null };
		try {
			payload = JSON.parse(me);
		} catch (err) {
			this.opts.handlers.onError?.(orgId, err);
			return;
		}
		if (payload.deviceId && payload.deviceId === this.opts.myDeviceId) return;
		const cb = this.opts.handlers[key];
		if (!cb) return;
		Promise.resolve(cb(payload as never)).catch((err) => this.opts.handlers.onError?.(orgId, err));
	}

	private dispatchPresence(orgId: string, e: Event): void {
		const me = (e as MessageEvent).data;
		let payload: PresenceChangedEvent;
		try {
			payload = JSON.parse(me);
		} catch (err) {
			this.opts.handlers.onError?.(orgId, err);
			return;
		}
		const cb = this.opts.handlers.onPresenceChanged;
		if (!cb) return;
		Promise.resolve(cb(payload)).catch((err) => this.opts.handlers.onError?.(orgId, err));
	}
}
