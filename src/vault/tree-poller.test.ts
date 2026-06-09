import { TreePoller } from "./tree-poller";

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
