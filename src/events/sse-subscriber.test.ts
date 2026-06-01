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

function make(handlers: EventsHandlers, myDeviceId = "self"): { events: MayaspaceEvents; sources: FakeEventSource[] } {
	FakeEventSource.instances = [];
	const events = new MayaspaceEvents({
		restUrl: "http://x",
		token: "t",
		myDeviceId,
		handlers,
		eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
	});
	return { events, sources: FakeEventSource.instances };
}

describe("MayaspaceEvents", () => {
	test("subscribe는 org당 한 EventSource를 만들고 token을 query로 붙인다", () => {
		const { events, sources } = make({});
		events.subscribe("org1");
		events.subscribe("org1");
		events.subscribe("org2");
		expect(sources).toHaveLength(2);
		expect(sources[0].url).toBe("http://x/v1/orgs/org1/events?token=t");
		expect(sources[1].url).toBe("http://x/v1/orgs/org2/events?token=t");
	});

	test("file.created/deleted/moved 이벤트는 해당 핸들러로 dispatch된다", () => {
		const onCreated = jest.fn();
		const onDeleted = jest.fn();
		const onMoved = jest.fn();
		const { events, sources } = make({ onCreated, onDeleted, onMoved });
		events.subscribe("org1");

		sources[0].fire("file.created", { orgId: "org1", fileId: "f1", path: "a.md", deviceId: "peer" });
		sources[0].fire("file.deleted", { orgId: "org1", fileId: "f2", path: "b.md", deviceId: "peer" });
		sources[0].fire("file.moved", { orgId: "org1", fileId: "f3", oldPath: "c.md", newPath: "d.md", deviceId: "peer" });

		expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f1" }));
		expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f2" }));
		expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f3" }));
	});

	test("자기 deviceId가 발생시킨 이벤트는 거른다", () => {
		const onCreated = jest.fn();
		const { events, sources } = make({ onCreated }, "self");
		events.subscribe("org1");
		sources[0].fire("file.created", { orgId: "org1", fileId: "f1", path: "a.md", deviceId: "self" });
		expect(onCreated).not.toHaveBeenCalled();
	});

	test("unsubscribeAll은 모든 EventSource를 close한다", () => {
		const { events, sources } = make({});
		events.subscribe("org1");
		events.subscribe("org2");
		events.unsubscribeAll();
		expect(sources[0].closed).toBe(true);
		expect(sources[1].closed).toBe(true);
	});
});
