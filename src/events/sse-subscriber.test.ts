import { MayaspaceEvents, type EventsHandlers } from "./sse-subscriber";

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	url: string;
	closed = false;
	listeners = new Map<string, ((e: MessageEvent | Event) => void)[]>();

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, cb: (e: MessageEvent | Event) => void): void {
		const arr = this.listeners.get(type) ?? [];
		arr.push(cb);
		this.listeners.set(type, arr);
	}
	close(): void {
		this.closed = true;
	}
	fire(type: string, data: unknown): void {
		const cbs = this.listeners.get(type) ?? [];
		for (const cb of cbs) cb({ data: JSON.stringify(data) } as MessageEvent);
	}
}

// connect()는 getTicket을 await한 뒤 EventSource를 만든다 — 마이크로태스크/타이머가
// 가라앉도록 한 틱 기다린다.
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(handlers: EventsHandlers, myDeviceId = "self"): { events: MayaspaceEvents; sources: FakeEventSource[] } {
	FakeEventSource.instances = [];
	const events = new MayaspaceEvents({
		restUrl: "http://x",
		getTicket: async () => "tk",
		myDeviceId,
		handlers,
		eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
		reconnectBaseMs: 0,
		reconnectMaxMs: 0,
	});
	return { events, sources: FakeEventSource.instances };
}

describe("MayaspaceEvents", () => {
	test("subscribe는 org당 한 EventSource를 만들고 ticket을 query로 붙인다", async () => {
		const { events, sources } = make({});
		events.subscribe("org1");
		events.subscribe("org1");
		events.subscribe("org2");
		await flush();
		expect(sources).toHaveLength(2);
		expect(sources[0].url).toBe("http://x/v1/orgs/org1/events?ticket=tk");
		expect(sources[1].url).toBe("http://x/v1/orgs/org2/events?ticket=tk");
	});

	test("file.created/deleted/moved 이벤트는 해당 핸들러로 dispatch된다", async () => {
		const onCreated = jest.fn();
		const onDeleted = jest.fn();
		const onMoved = jest.fn();
		const { events, sources } = make({ onCreated, onDeleted, onMoved });
		events.subscribe("org1");
		await flush();

		sources[0].fire("file.created", { orgId: "org1", fileId: "f1", path: "a.md", deviceId: "peer" });
		sources[0].fire("file.deleted", { orgId: "org1", fileId: "f2", path: "b.md", deviceId: "peer" });
		sources[0].fire("file.moved", { orgId: "org1", fileId: "f3", oldPath: "c.md", newPath: "d.md", deviceId: "peer" });

		expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f1" }));
		expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f2" }));
		expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f3" }));
	});

	test("access.changed 이벤트는 onAccessChanged(orgId)로 dispatch된다", async () => {
		const onAccessChanged = jest.fn();
		const { events, sources } = make({ onAccessChanged });
		events.subscribe("org1");
		await flush();

		sources[0].fire("access.changed", { orgId: "org1" });

		expect(onAccessChanged).toHaveBeenCalledWith("org1");
	});

	test("자기 deviceId가 발생시킨 이벤트는 거른다", async () => {
		const onCreated = jest.fn();
		const { events, sources } = make({ onCreated }, "self");
		events.subscribe("org1");
		await flush();
		sources[0].fire("file.created", { orgId: "org1", fileId: "f1", path: "a.md", deviceId: "self" });
		expect(onCreated).not.toHaveBeenCalled();
	});

	test("unsubscribeAll은 모든 EventSource를 close한다", async () => {
		const { events, sources } = make({});
		events.subscribe("org1");
		events.subscribe("org2");
		await flush();
		events.unsubscribeAll();
		expect(sources[0].closed).toBe(true);
		expect(sources[1].closed).toBe(true);
	});

	test("연결 에러 시 이전 소스를 닫고 새 단발성 ticket으로 재연결한다", async () => {
		let n = 0;
		FakeEventSource.instances = [];
		const events = new MayaspaceEvents({
			restUrl: "http://x",
			getTicket: async () => `tk${++n}`,
			myDeviceId: "self",
			handlers: {},
			eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
			reconnectBaseMs: 0,
			reconnectMaxMs: 0,
		});
		const sources = FakeEventSource.instances;

		events.subscribe("org1");
		await flush();
		expect(sources).toHaveLength(1);
		expect(sources[0].url).toContain("ticket=tk1");

		sources[0].fire("error", {});
		await flush();
		await flush();

		expect(sources[0].closed).toBe(true);
		expect(sources).toHaveLength(2);
		expect(sources[1].url).toContain("ticket=tk2");
	});
});
