import * as Y from "yjs";
import { LiveCollabSession, type SessionDeps } from "./live-collab-session";

function makeDeps(overrides: Partial<SessionDeps> = {}): {
	deps: SessionDeps;
	calls: { readFile: any[]; openDoc: any[]; closeDoc: any[] };
} {
	const calls = { readFile: [], openDoc: [], closeDoc: [] } as any;
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "server-content");

	const deps: SessionDeps = {
		api: {
			readFile: async (orgId, fileId) => {
				calls.readFile.push({ orgId, fileId });
				return { content: "server-content" };
			},
		},
		sync: {
			openDoc: async (orgId, fileId) => {
				calls.openDoc.push({ orgId, fileId });
				return { doc, awareness: {}, destroy: () => {} };
			},
			closeDoc: async (orgId, fileId) => {
				calls.closeDoc.push({ orgId, fileId });
			},
			onPermissionLost: () => () => {},
		},
		bindEditor: () => () => {},
		findEditorView: () => null,
		...overrides,
	};
	return { deps, calls };
}

describe("LiveCollabSession", () => {
	// ytext is ground truth — the local placeholder is left alone. Earlier
	// iterations replaced placeholder content via vault.modify and that raced
	// with yCollab's first sync, doubling the body. We removed the vault
	// dependency from the session entirely.
	test("attach: openDoc만 호출, readFile은 안 한다", async () => {
		const { deps, calls } = makeDeps();
		const session = new LiveCollabSession(deps);

		await session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" });

		expect(calls.readFile).toEqual([]);
		expect(calls.openDoc).toEqual([{ orgId: "o1", fileId: "f1" }]);
	});

	test("detach: 열린 세션을 닫고 closeDoc을 부른다", async () => {
		const { deps, calls } = makeDeps();
		const session = new LiveCollabSession(deps);

		await session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" });
		await session.detach("MayaSpace/dev/a.md");

		expect(calls.closeDoc).toEqual([{ orgId: "o1", fileId: "f1" }]);
	});

	test("detach: 매핑에 없는 path는 무동작", async () => {
		const { deps, calls } = makeDeps();
		const session = new LiveCollabSession(deps);
		await session.detach("nope/x.md");
		expect(calls.closeDoc).toEqual([]);
	});

	test("같은 path에 attach 두 번 부르면 두 번째는 무시(중복 방지)", async () => {
		const { deps, calls } = makeDeps();
		const session = new LiveCollabSession(deps);

		await session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" });
		await session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" });

		expect(calls.openDoc.length).toBe(1);
	});

	test("attach: 같은 path에 대해 동시에 두 번 호출하면 한 번만 열린다", async () => {
		const { deps, calls } = makeDeps();
		const session = new LiveCollabSession(deps);

		await Promise.all([
			session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" }),
			session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" }),
		]);

		expect(calls.openDoc.length).toBe(1);
	});

	test("attach: provider sync 완료 전에는 bindEditor를 호출하지 않는다", async () => {
		// 재attach 시 새 Y.Doc은 sync 전이라 비어있다. sync 전에 바인딩하면
		// bindYCollab의 시드 분기가 에디터 본문을 ytext에 넣고, 직후 서버/IndexedDB
		// sync가 같은 본문을 머지하며 내용이 2배가 된다(데이터 손상). 그래서
		// 바인딩은 반드시 whenSynced 이후여야 한다.
		let resolveSynced!: () => void;
		const whenSynced = new Promise<void>((r) => { resolveSynced = r; });
		const doc = new Y.Doc();
		const bindCalls: unknown[] = [];
		const session = new LiveCollabSession({
			api: { readFile: async () => ({ content: "" }) },
			sync: {
				openDoc: async () => ({ doc, awareness: {}, destroy: () => {}, whenSynced }),
				closeDoc: async () => {},
				onPermissionLost: () => () => {},
			},
			bindEditor: (_view, handle) => { bindCalls.push(handle); return () => {}; },
			findEditorView: () => ({}),
		});

		const p = session.attach("p.md", { orgId: "o1", fileId: "f1" });
		await new Promise((r) => setImmediate(r));
		expect(bindCalls).toHaveLength(0); // sync 전 — 아직 바인딩 안 함

		resolveSynced();
		await p;
		expect(bindCalls).toHaveLength(1); // sync 후 — 바인딩
	});

	test("attach 진행 중 detach 호출: attach 완료 후 정리된다", async () => {
		let resolveOpen!: (h: any) => void;
		const doc = new Y.Doc();
		const calls = { closeDoc: [] as any[] };
		const session = new LiveCollabSession({
			api: { readFile: async () => ({ content: "" }) },
			sync: {
				openDoc: () => new Promise<any>((r) => { resolveOpen = r; }),
				closeDoc: async (oid, fid) => { calls.closeDoc.push({ oid, fid }); },
				onPermissionLost: () => () => {},
			},
			bindEditor: () => () => {},
			findEditorView: () => null,
		});

		const attachP = session.attach("p.md", { orgId: "o1", fileId: "f1" });
		const detachP = session.detach("p.md");
		await new Promise((r) => setImmediate(r));
		resolveOpen({ doc, awareness: {}, destroy: () => {} });
		await Promise.all([attachP, detachP]);

		expect(calls.closeDoc).toEqual([{ oid: "o1", fid: "f1" }]);
		expect(session.activePaths()).toEqual([]);
	});

	test("attach: readOnly 옵션을 bindEditor의 3번째 인자로 전달한다", async () => {
		const doc = new Y.Doc();
		const bindArgs: unknown[][] = [];
		const session = new LiveCollabSession({
			api: { readFile: async () => ({ content: "" }) },
			sync: {
				openDoc: async () => ({ doc, awareness: {}, destroy: () => {} }),
				closeDoc: async () => {},
				onPermissionLost: () => () => {},
			},
			bindEditor: (...args: unknown[]) => { bindArgs.push(args); return () => {}; },
			findEditorView: () => ({}),
		});

		await session.attach("p.md", { orgId: "o1", fileId: "f1" }, { readOnly: true });

		expect(bindArgs).toHaveLength(1);
		expect(bindArgs[0][2]).toBe(true);
	});

	test("attach: 옵션이 없으면 readOnly는 false로 전달된다", async () => {
		const doc = new Y.Doc();
		const bindArgs: unknown[][] = [];
		const session = new LiveCollabSession({
			api: { readFile: async () => ({ content: "" }) },
			sync: {
				openDoc: async () => ({ doc, awareness: {}, destroy: () => {} }),
				closeDoc: async () => {},
				onPermissionLost: () => () => {},
			},
			bindEditor: (...args: unknown[]) => { bindArgs.push(args); return () => {}; },
			findEditorView: () => ({}),
		});

		await session.attach("p.md", { orgId: "o1", fileId: "f1" });

		expect(bindArgs).toHaveLength(1);
		expect(bindArgs[0][2]).toBe(false);
	});

	test("handleFor: active 세션의 provider handle을 반환한다(없으면 null)", async () => {
		const { deps } = makeDeps();
		const session = new LiveCollabSession(deps);

		expect(session.handleFor("MayaSpace/dev/a.md")).toBeNull();

		await session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" });
		const handle = session.handleFor("MayaSpace/dev/a.md");
		expect(handle).not.toBeNull();
		expect(handle!.doc.getText("content").toString()).toBe("server-content");

		await session.detach("MayaSpace/dev/a.md");
		expect(session.handleFor("MayaSpace/dev/a.md")).toBeNull();
	});

	test("activePaths는 현재 active 세션의 path 배열을 반환한다", async () => {
		const { deps } = makeDeps();
		const session = new LiveCollabSession(deps);

		expect(session.activePaths()).toEqual([]);
		await session.attach("MayaSpace/dev/a.md", { orgId: "o1", fileId: "f1" });
		expect(session.activePaths()).toEqual(["MayaSpace/dev/a.md"]);
		await session.detach("MayaSpace/dev/a.md");
		expect(session.activePaths()).toEqual([]);
	});
});
