import { MayaspaceSync, type ProviderHandle, type ProviderFactory } from "./mayaspace-sync";
import { MayaspaceAuth, InMemoryTokenStorage } from "../auth/mayaspace-auth";
import * as Y from "yjs";

function makeMockFactory() {
	const created: Array<{ url: string; name: string; getToken: () => Promise<string> }> = [];
	const handles: ProviderHandle[] = [];
	const factory: ProviderFactory = ({ url, name, getToken, onStatus, onAuthFailure }) => {
		created.push({ url, name, getToken });
		const doc = new Y.Doc();
		const awareness = { destroy: jest.fn() } as any;
		const handle: ProviderHandle = {
			doc,
			awareness,
			destroy: jest.fn(),
			_triggerStatus: (s: any) => onStatus?.(s),
			_triggerAuthFailure: () => onAuthFailure?.(),
		} as any;
		handles.push(handle);
		return handle;
	};
	return { factory, created, handles };
}

async function authedAuth(): Promise<MayaspaceAuth> {
	const storage = new InMemoryTokenStorage();
	await storage.save({ accessToken: "AT-1", refreshToken: "RT-1", expiresAt: Date.now() + 60_000 });
	return new MayaspaceAuth("https://api.test", async () => ({
		status: 200, ok: true,
		text: async () => "{}", json: async <T>() => ({} as T),
		arrayBuffer: async () => new ArrayBuffer(0),
		headers: {},
	}), storage);
}

describe("MayaspaceSync.openDoc", () => {
	test("올바른 doc name (org:<oid>:file:<fid>) + JWT로 provider 생성", async () => {
		const { factory, created } = makeMockFactory();
		const auth = await authedAuth();
		const sync = new MayaspaceSync("ws://localhost:3001", auth, factory);

		const handle = await sync.openDoc("org-1", "file-9");

		expect(created).toHaveLength(1);
		expect(created[0].name).toBe("org:org-1:file:file-9");
		expect(created[0].url).toBe("ws://localhost:3001");
		expect(await created[0].getToken()).toBe("AT-1");
		expect(handle.doc).toBeInstanceOf(Y.Doc);
	});

	test("같은 (org, file) 두 번 open 시 같은 handle 재사용", async () => {
		const { factory, created } = makeMockFactory();
		const auth = await authedAuth();
		const sync = new MayaspaceSync("ws://localhost:3001", auth, factory);

		const h1 = await sync.openDoc("o", "f");
		const h2 = await sync.openDoc("o", "f");
		expect(created).toHaveLength(1);
		expect(h1).toBe(h2);
	});
});

describe("MayaspaceSync.closeDoc", () => {
	test("provider destroy + 캐시 제거", async () => {
		const { factory, handles } = makeMockFactory();
		const auth = await authedAuth();
		const sync = new MayaspaceSync("ws://localhost:3001", auth, factory);

		await sync.openDoc("o", "f");
		await sync.closeDoc("o", "f");

		expect(handles[0].destroy).toHaveBeenCalled();
		await sync.openDoc("o", "f");
		expect(handles).toHaveLength(2);
	});

	test("열려있지 않은 (o, f) close는 noop", async () => {
		const { factory } = makeMockFactory();
		const auth = await authedAuth();
		const sync = new MayaspaceSync("ws://localhost:3001", auth, factory);
		await expect(sync.closeDoc("o", "nope")).resolves.toBeUndefined();
	});
});

describe("MayaspaceSync.closeAll", () => {
	test("모든 provider destroy", async () => {
		const { factory, handles } = makeMockFactory();
		const auth = await authedAuth();
		const sync = new MayaspaceSync("ws://localhost:3001", auth, factory);

		await sync.openDoc("o1", "f1");
		await sync.openDoc("o1", "f2");
		await sync.closeAll();

		expect(handles[0].destroy).toHaveBeenCalled();
		expect(handles[1].destroy).toHaveBeenCalled();
	});
});

describe("MayaspaceSync auth failure 처리", () => {
	test("auth 실패 콜백 발화 시 doc 닫고 listener에 통지", async () => {
		const { factory, handles } = makeMockFactory();
		const auth = await authedAuth();
		const sync = new MayaspaceSync("ws://localhost:3001", auth, factory);

		const onPermissionLost = jest.fn();
		sync.onPermissionLost(onPermissionLost);

		await sync.openDoc("o", "f");
		(handles[0] as any)._triggerAuthFailure();

		expect(onPermissionLost).toHaveBeenCalledWith({ orgId: "o", fileId: "f" });
		await sync.openDoc("o", "f");
		expect(handles).toHaveLength(2);
	});
});
