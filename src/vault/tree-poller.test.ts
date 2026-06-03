import { TreePoller } from "./tree-poller";

function makeVault() {
	const files = new Set<string>();
	return {
		getAbstractFileByPath: (p: string) => (files.has(p) ? {} : null),
		create: async (p: string) => { files.add(p); },
		createFolder: async (p: string) => { files.add(p); },
		delete: async (p: unknown) => { files.delete(String(p)); },
		_files: files,
	};
}

it("서버 트리에서 사라진 파일 → onFileLost 호출 + 매핑 제거", async () => {
	const known: Record<string, { orgId: string; fileId: string }> = {
		"MayaSpace/Acme/taeho/gone.md": { orgId: "o1", fileId: "f-gone" },
	};
	const lost: string[] = [];
	const vault = makeVault();
	vault._files.add("MayaSpace/Acme/taeho/gone.md");
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
