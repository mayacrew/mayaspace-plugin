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

export interface EventsHandlers {
	onCreated?: (p: FileCreatedEvent) => void | Promise<void>;
	onDeleted?: (p: FileDeletedEvent) => void | Promise<void>;
	onMoved?: (p: FileMovedEvent) => void | Promise<void>;
	onUpdated?: (p: FileUpdatedEvent) => void | Promise<void>;
	onError?: (orgId: string, e: unknown) => void;
}

export interface EventsClientOptions {
	restUrl: string;
	token: string;
	myDeviceId: string;
	handlers: EventsHandlers;
	/** EventSource constructor (test injection). Defaults to globalThis.EventSource. */
	eventSourceCtor?: typeof EventSource;
}

export class MayaspaceEvents {
	private readonly sources = new Map<string, EventSource>();
	private readonly Ctor: typeof EventSource;

	constructor(private readonly opts: EventsClientOptions) {
		this.Ctor = opts.eventSourceCtor ?? (globalThis as { EventSource: typeof EventSource }).EventSource;
	}

	subscribe(orgId: string): void {
		if (this.sources.has(orgId)) return;
		const url = `${this.opts.restUrl}/v1/orgs/${orgId}/events?token=${encodeURIComponent(this.opts.token)}`;
		const es = new this.Ctor(url);

		es.addEventListener("file.created", (e) => this.dispatch(orgId, e, "onCreated"));
		es.addEventListener("file.deleted", (e) => this.dispatch(orgId, e, "onDeleted"));
		es.addEventListener("file.moved", (e) => this.dispatch(orgId, e, "onMoved"));
		es.addEventListener("file.updated", (e) => this.dispatch(orgId, e, "onUpdated"));
		es.addEventListener("error", (e) => this.opts.handlers.onError?.(orgId, e));

		this.sources.set(orgId, es);
	}

	unsubscribe(orgId: string): void {
		const es = this.sources.get(orgId);
		if (!es) return;
		es.close();
		this.sources.delete(orgId);
	}

	unsubscribeAll(): void {
		for (const es of this.sources.values()) es.close();
		this.sources.clear();
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
}
