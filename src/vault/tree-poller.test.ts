import { TreePoller, shouldSkipMassDeletion, classifyKnownMappings } from "./tree-poller";

describe("classifyKnownMappings", () => {
	const orgFolder = "MayaSpace/Acme";

	test("NFD 로컬 경로를 NFC 서버 경로와 동일하게 본다 (손실/이동 오판 방지)", () => {
		// macOS는 한글 파일명을 NFD로 저장 → 매핑 키는 NFD, 서버 트리 경로는 NFC.
		const nfd = `${orgFolder}/가나다.md`.normalize("NFD");
		const nfc = `${orgFolder}/가나다.md`.normalize("NFC");
		const known = { [nfd]: { orgId: "o1", fileId: "f1" } };
		const r = classifyKnownMappings(known, new Set([nfc]), new Set(["f1"]), "o1", orgFolder);
		// 서버에 멀쩡히 있는 파일이므로 present — moved도 lost도 아니어야 한다(byte 비교였다면 moved로 오판).
		expect(r.lost).toEqual([]);
		expect(r.moved).toEqual([]);
		expect(r.knownInOrg).toBe(1);
	});

	test("트리에서 정말 사라진 파일은 lost", () => {
		const p = `${orgFolder}/gone.md`;
		const known = { [p]: { orgId: "o1", fileId: "f-gone" } };
		const r = classifyKnownMappings(known, new Set(), new Set(), "o1", orgFolder);
		expect(r.lost).toEqual([[p, { orgId: "o1", fileId: "f-gone" }]]);
		expect(r.moved).toEqual([]);
	});

	test("fileId가 트리에 남아 있으면(경로만 바뀜) moved", () => {
		const old = `${orgFolder}/old.md`;
		const known = { [old]: { orgId: "o1", fileId: "f1" } };
		const r = classifyKnownMappings(known, new Set([`${orgFolder}/new.md`]), new Set(["f1"]), "o1", orgFolder);
		expect(r.moved).toEqual([[old, { orgId: "o1", fileId: "f1" }]]);
		expect(r.lost).toEqual([]);
	});

	test("다른 org·org 폴더 밖 매핑은 무시한다", () => {
		const known = {
			[`${orgFolder}/a.md`]: { orgId: "other", fileId: "fa" },
			["MayaSpace/Other/b.md"]: { orgId: "o1", fileId: "fb" },
		};
		const r = classifyKnownMappings(known, new Set(), new Set(), "o1", orgFolder);
		expect(r.knownInOrg).toBe(0);
		expect(r.lost).toEqual([]);
	});
});

describe("shouldSkipMassDeletion", () => {
	test("삭제 후보 0이면 건너뛰지 않는다", () => {
		expect(shouldSkipMassDeletion(0, 100)).toBe(false);
	});
	test("소수 삭제는 진행한다(단일 파일 삭제 등)", () => {
		expect(shouldSkipMassDeletion(1, 1)).toBe(false);
		expect(shouldSkipMassDeletion(3, 100)).toBe(false);
	});
	test("대량(절대치+비율 초과)이면 건너뛴다 — 빈/부분 트리 열화", () => {
		expect(shouldSkipMassDeletion(100, 100)).toBe(true); // 빈 트리로 전부 사라짐
		expect(shouldSkipMassDeletion(60, 100)).toBe(true);
	});
	test("절대치는 넘지만 비율 미만이면 진행한다", () => {
		expect(shouldSkipMassDeletion(20, 100)).toBe(false);
	});
	test("절대치 미만이면 비율이 높아도 진행한다(작은 org)", () => {
		expect(shouldSkipMassDeletion(5, 5)).toBe(false);
	});
});

// Mirror Obsidian's contract: vault.delete requires a TAbstractFile object,
// not a string path. Passing a string throws — the old mock hid that bug.
function makeVault() {
	const files = new Map<string, { path: string }>();
	return {
		getAbstractFileByPath: (p: string) => files.get(p) ?? null,
		create: async (p: string) => { files.set(p, { path: p }); },
		createFolder: async (p: string) => { files.set(p, { path: p }); },
		delete: async (f: unknown) => {
			if (!f || typeof f !== "object" || typeof (f as { path?: unknown }).path !== "string") {
				throw new Error("vault.delete requires a TAbstractFile");
			}
			files.delete((f as { path: string }).path);
		},
		_files: files,
	};
}

it("서버 트리에서 사라진 파일 → onFileLost 호출 + 매핑 제거", async () => {
	const known: Record<string, { orgId: string; fileId: string }> = {
		"MayaSpace/Acme/taeho/gone.md": { orgId: "o1", fileId: "f-gone" },
	};
	const lost: string[] = [];
	const vault = makeVault();
	vault._files.set("MayaSpace/Acme/taeho/gone.md", { path: "MayaSpace/Acme/taeho/gone.md" });
	const poller = new TreePoller(
		{ listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [] },                       // 트리 비어 있음 = 회수
		vault as any,
		{
			getKnownFiles: () => known,
			addFileMapping: async () => {},
			removeFileMapping: async (p) => { delete known[p]; },
			sanitizeOrgFolderName: (n) => n,
			mayaspaceRoot: () => "MayaSpace",
			onFileLost: (p) => { lost.push(p); },
		},
		1000,
	);
	await poller.tick();
	expect(lost).toContain("MayaSpace/Acme/taeho/gone.md");
	expect(known["MayaSpace/Acme/taeho/gone.md"]).toBeUndefined();
	// The local .md must actually be gone from the vault — not just unmapped.
	expect(vault._files.has("MayaSpace/Acme/taeho/gone.md")).toBe(false);
});

it("동기화 진행 중(isSyncing)이면 손실 삭제를 건너뛴다 — 벌크 중 매핑 flux 오판 방지", async () => {
	// 벌크 수신 중엔 syncTrees가 공유 매핑을 대량 갱신한다. 폴러가 그 도중 매핑 스냅샷을
	// 다른 시점의 트리와 비교하면 서버에 멀쩡히 있는 파일을 손실로 오판한다(onFileLost 폭주).
	const known: Record<string, { orgId: string; fileId: string }> = {
		"MayaSpace/Acme/taeho/gone.md": { orgId: "o1", fileId: "f-gone" },
	};
	const lost: string[] = [];
	const vault = makeVault();
	vault._files.set("MayaSpace/Acme/taeho/gone.md", { path: "MayaSpace/Acme/taeho/gone.md" });
	const poller = new TreePoller(
		{ listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [] },                       // 트리 비어 보여도(동기화 중 부분응답)
		vault as any,
		{
			getKnownFiles: () => known,
			addFileMapping: async () => {},
			removeFileMapping: async (p) => { delete known[p]; },
			sanitizeOrgFolderName: (n) => n,
			mayaspaceRoot: () => "MayaSpace",
			onFileLost: (p) => { lost.push(p); },
			isSyncing: () => true,                            // 동기화 중 → 삭제 보류
		},
		1000,
	);
	await poller.tick();
	expect(lost).toEqual([]);                              // 삭제 안 함
	expect(known["MayaSpace/Acme/taeho/gone.md"]).toBeDefined(); // 매핑 유지
	expect(vault._files.has("MayaSpace/Acme/taeho/gone.md")).toBe(true); // 로컬 파일 유지
});

it("이동된 파일(같은 fileId, 새 경로)은 lost로 보지 않는다 — purge 금지", async () => {
	// rename: 서버에서 fileId는 그대로고 경로만 바뀐다. 옛 경로가 serverPaths에서
	// 빠져도 fileId가 살아있으면 onFileLost(=purgeDoc)를 타면 안 된다. 안 그러면
	// 새 경로의 live 세션을 죽이고 IndexedDB 재오픈과 레이스한다.
	const known: Record<string, { orgId: string; fileId: string }> = {
		"MayaSpace/Acme/delete/Untitled.md": { orgId: "o1", fileId: "f1" },
	};
	const lost: string[] = [];
	const vault = makeVault();
	vault._files.set("MayaSpace/Acme/delete/Untitled.md", { path: "MayaSpace/Acme/delete/Untitled.md" });
	const poller = new TreePoller(
		{ listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [{ id: "f1", path: "delete/pp.md", effective_permissions: 15 }] },
		vault as any,
		{
			getKnownFiles: () => known,
			addFileMapping: async (p, m) => { known[p] = m; },
			removeFileMapping: async (p) => { delete known[p]; },
			sanitizeOrgFolderName: (n) => n,
			mayaspaceRoot: () => "MayaSpace",
			onFileLost: (p) => { lost.push(p); },
		},
		1000,
	);
	await poller.tick();
	// 이동이므로 lost(=purge) 호출 없어야 한다.
	expect(lost).toEqual([]);
	// 새 경로는 매핑됨, 옛 경로 매핑은 정리됨.
	expect(known["MayaSpace/Acme/delete/pp.md"]).toEqual({ orgId: "o1", fileId: "f1" });
	expect(known["MayaSpace/Acme/delete/Untitled.md"]).toBeUndefined();
});

it("매핑을 vault.delete보다 먼저 제거한다 (vault.on('delete') → 서버 삭제 전파 방지)", async () => {
	// vault.delete는 프로그램 호출에도 vault.on('delete')를 발화시킨다. 그 시점에
	// 매핑이 남아 있으면 handleVaultDelete가 DELETE 권한 있는 클라이언트(소유자)에서
	// api.deleteFile을 호출해 로컬 정리가 서버 삭제로 번진다. 매핑을 먼저 지워야 한다.
	const known: Record<string, { orgId: string; fileId: string }> = {
		"MayaSpace/Acme/taeho/gone.md": { orgId: "o1", fileId: "f-gone" },
	};
	const order: string[] = [];
	const vault = makeVault();
	vault._files.set("MayaSpace/Acme/taeho/gone.md", { path: "MayaSpace/Acme/taeho/gone.md" });
	const origDelete = vault.delete;
	vault.delete = async (f: unknown) => { order.push("delete"); return origDelete(f); };
	const poller = new TreePoller(
		{ listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [] },
		vault as any,
		{
			getKnownFiles: () => known,
			addFileMapping: async () => {},
			removeFileMapping: async (p) => { order.push("removeMapping"); delete known[p]; },
			sanitizeOrgFolderName: (n) => n,
			mayaspaceRoot: () => "MayaSpace",
		},
		1000,
	);
	await poller.tick();
	expect(order).toEqual(["removeMapping", "delete"]);
});

it("트리에 (재)등장한 파일 → addFileMapping + placeholder 생성 (재부여 복원 경로)", async () => {
	const known: Record<string, { orgId: string; fileId: string }> = {};
	const added: string[] = [];
	const vault = makeVault();
	const poller = new TreePoller(
		{ listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [{ id: "f1", path: "taeho/back.md", effective_permissions: 15 }] },
		vault as any,
		{
			getKnownFiles: () => known,
			addFileMapping: async (p, m) => { known[p] = m; added.push(p); },
			removeFileMapping: async () => {},
			sanitizeOrgFolderName: (n) => n,
			mayaspaceRoot: () => "MayaSpace",
		},
		1000,
	);
	await poller.tick();
	expect(added).toContain("MayaSpace/Acme/taeho/back.md");
	expect(vault._files.has("MayaSpace/Acme/taeho/back.md")).toBe(true);
});

it("매핑은 있는데 로컬 vault 파일이 없으면 placeholder를 재생성한다 (self-heal)", async () => {
	// onCreated 누락·벌크 레이스로 '매핑만 있고 로컬 파일은 없는' 고아 상태가 생긴다.
	// 폴러가 매핑만 보고 건너뛰면 그 파일은 영영 안 생긴다(reload만 고침). 로컬 파일이
	// 없으면 다시 만들어야 한다.
	const known: Record<string, { orgId: string; fileId: string }> = {
		"MayaSpace/Acme/sub/0003.md": { orgId: "o1", fileId: "f3" },
	};
	const vault = makeVault(); // 매핑은 있지만 vault엔 파일 없음(고아 매핑)
	const poller = new TreePoller(
		{ listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [{ id: "f3", path: "sub/0003.md", effective_permissions: 15 }] },
		vault as any,
		{
			getKnownFiles: () => known,
			addFileMapping: async (p, m) => { known[p] = m; },
			removeFileMapping: async (p) => { delete known[p]; },
			sanitizeOrgFolderName: (n) => n,
			mayaspaceRoot: () => "MayaSpace",
		},
		1000,
	);
	await poller.tick();
	expect(vault._files.has("MayaSpace/Acme/sub/0003.md")).toBe(true); // 재생성됨
});

it("한 파일 생성 실패가 같은 org의 다른 파일 생성을 막지 않는다 (틱 격리)", async () => {
	// 한 파일의 vault.create 에러가 throw로 org 전체 틱을 중단시키면, 그 뒤 파일들이
	// 안 생긴다(대형 vault 수렴 실패). 파일별로 격리해 실패는 onError로 보고하고 진행해야 한다.
	const known: Record<string, { orgId: string; fileId: string }> = {};
	const errors: unknown[] = [];
	const vault = makeVault();
	const origCreate = vault.create;
	vault.create = async (p: string) => {
		if (p === "MayaSpace/Acme/sub/bad.md") throw new Error("boom"); // 한 파일만 실패
		return origCreate(p);
	};
	const poller = new TreePoller(
		{ listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [
				{ id: "f1", path: "sub/good1.md", effective_permissions: 15 },
				{ id: "f2", path: "sub/bad.md", effective_permissions: 15 },
				{ id: "f3", path: "sub/good2.md", effective_permissions: 15 },
			] },
		vault as any,
		{
			getKnownFiles: () => known,
			addFileMapping: async (p, m) => { known[p] = m; },
			removeFileMapping: async (p) => { delete known[p]; },
			sanitizeOrgFolderName: (n) => n,
			mayaspaceRoot: () => "MayaSpace",
			onError: (e) => { errors.push(e); },
		},
		1000,
	);
	await poller.tick();
	expect(vault._files.has("MayaSpace/Acme/sub/good1.md")).toBe(true);
	expect(vault._files.has("MayaSpace/Acme/sub/good2.md")).toBe(true); // bad 뒤에도 생성됨
	expect(vault._files.has("MayaSpace/Acme/sub/bad.md")).toBe(false);
	expect(errors.length).toBe(1); // 실패는 onError로 보고
});
