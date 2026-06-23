/**
 * Subscribe to per-org file event streams via SSE.
 *
 * GET /v1/orgs/:oid/events emits `file.created`, `file.deleted`, `file.moved`.
 * EventSource cannot send custom headers, so authentication travels in the
 * query string. We do NOT put the JWT there (it would leak into server logs /
 * proxies). Instead the caller exchanges the JWT for a short-lived, single-use
 * SSE ticket (POST /v1/auth/sse-ticket, 30s TTL) and we connect with
 * `?ticket=`. Because the ticket is single-use, every (re)connect fetches a
 * fresh one via getTicket().
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
	/** 수신자 기준 effective_permissions. 서버가 실어주면 권위값으로 캐시. */
	effective_permissions?: number;
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
	/** 수신자 기준 effective_permissions(새 경로). 서버가 실어주면 권위값으로 캐시. */
	effective_permissions?: number;
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
	/** 조직 권한 변경 신호. 클라가 즉시 권한을 재동기화(syncTrees)하도록 트리거. */
	onAccessChanged?: (orgId: string) => void | Promise<void>;
	/** 대량 burst를 묶은 트리 무효화 신호(I1). 클라가 트리를 재동기화(syncTrees)하도록 트리거. */
	onTreeChanged?: (orgId: string) => void | Promise<void>;
	onError?: (orgId: string, e: unknown) => void;
}

export interface EventsClientOptions {
	restUrl: string;
	/**
	 * Single-use SSE ticket provider. Called on every (re)connect: the ticket
	 * is consumed on connect and expires in ~30s, so a reconnect must fetch a
	 * fresh one instead of reusing a dead ticket. Implemented by the caller as
	 * POST /v1/auth/sse-ticket with the Bearer JWT.
	 */
	getTicket: () => Promise<string>;
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

	// 매 (재)연결마다 새 단발성 ticket을 받아 EventSource를 연다.
	private async connect(orgId: string): Promise<void> {
		const sub = this.subs.get(orgId);
		if (!sub || sub.closed) return;

		let ticket: string;
		try {
			ticket = await this.opts.getTicket();
		} catch (err) {
			this.opts.handlers.onError?.(orgId, err);
			this.scheduleReconnect(orgId);
			return;
		}
		if (sub.closed) return;

		const url = `${this.opts.restUrl}/v1/orgs/${orgId}/events?ticket=${encodeURIComponent(ticket)}`;
		const es = new this.Ctor(url);
		sub.source = es;

		es.addEventListener("file.created", (e) => this.dispatch(orgId, e, "onCreated"));
		es.addEventListener("file.deleted", (e) => this.dispatch(orgId, e, "onDeleted"));
		es.addEventListener("file.moved", (e) => this.dispatch(orgId, e, "onMoved"));
		es.addEventListener("file.updated", (e) => this.dispatch(orgId, e, "onUpdated"));
		es.addEventListener("presence.changed", (e) => this.dispatchPresence(orgId, e));
		// 권한 변경 신호. payload보다 구독 시점의 orgId가 권위적이라 그대로 넘긴다(deviceId 필터 없음).
		es.addEventListener("access.changed", () => {
			Promise.resolve(this.opts.handlers.onAccessChanged?.(orgId)).catch((err) =>
				this.opts.handlers.onError?.(orgId, err),
			);
		});
		// 트리 무효화 신호(I1 burst coalesce). payload 없이 구독 orgId로 트리 재동기화.
		es.addEventListener("tree.changed", () => {
			Promise.resolve(this.opts.handlers.onTreeChanged?.(orgId)).catch((err) =>
				this.opts.handlers.onError?.(orgId, err),
			);
		});
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
