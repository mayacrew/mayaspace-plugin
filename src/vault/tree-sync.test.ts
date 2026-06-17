import { syncOrgTrees, findUnmappedLocalFiles, type VaultLike, type ApiLike } from "./tree-sync";

function makeVault() {
	const existing = new Set<string>();
	const created: { folders: string[]; files: Array<{ path: string; content: string }> } = {
		folders: [],
		files: [],
	};
	const vault: VaultLike = {
		getAbstractFileByPath: (path) => (existing.has(path) ? ({ path } as any) : null),
		createFolder: async (path) => {
			if (existing.has(path)) throw new Error(`folder already exists: ${path}`);
			existing.add(path);
			created.folders.push(path);
		},
		create: async (path, content) => {
			if (existing.has(path)) throw new Error(`file already exists: ${path}`);
			existing.add(path);
			created.files.push({ path, content });
			return { path } as any;
		},
	};
	return { vault, created, existing };
}

function makeApi(orgs: Array<{ id: string; name: string }>, trees: Record<string, Array<{ id: string; path: string }>>): ApiLike {
	return {
		listOrgs: async () => orgs as any,
		getTree: async (oid) => (trees[oid] ?? []) as any,
	};
}

describe("syncOrgTrees", () => {
	test("루트 + 각 org 이름 폴더를 만든다", async () => {
		const { vault, created } = makeVault();
		const api = makeApi(
			[{ id: "o1", name: "Acme" }, { id: "o2", name: "Globex" }],
			{ o1: [], o2: [] },
		);

		await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });

		expect(created.folders).toEqual([".mayaspace", ".mayaspace/Acme", ".mayaspace/Globex"]);
	});

	test("이미 있는 폴더는 createFolder 호출 안 함", async () => {
		const { vault, created, existing } = makeVault();
		existing.add(".mayaspace");
		existing.add(".mayaspace/Acme");
		const api = makeApi([{ id: "o1", name: "Acme" }], { o1: [] });

		await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });

		expect(created.folders).toEqual([]);
	});

	test("getTree 결과 파일을 placeholder로 만든다", async () => {
		const { vault, created } = makeVault();
		const api = makeApi(
			[{ id: "o1", name: "Acme" }],
			{ o1: [{ id: "f1", path: "README.md" }, { id: "f2", path: "Welcome.md" }] },
		);

		await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });

		expect(created.files.map((f) => f.path)).toEqual([
			".mayaspace/Acme/README.md",
			".mayaspace/Acme/Welcome.md",
		]);
		expect(created.files[0].content).toBe("");
	});

	test("슬래시 포함 path는 중간 폴더부터 ensure", async () => {
		const { vault, created } = makeVault();
		const api = makeApi(
			[{ id: "o1", name: "Acme" }],
			{ o1: [{ id: "f1", path: "notes/idea.md" }] },
		);

		await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });

		expect(created.folders).toContain(".mayaspace/Acme/notes");
		expect(created.files.map((f) => f.path)).toEqual([".mayaspace/Acme/notes/idea.md"]);
	});

	test("org 이름에 슬래시가 있으면 - 로 치환", async () => {
		const { vault, created } = makeVault();
		const api = makeApi([{ id: "o1", name: "Acme/Sub" }], { o1: [] });

		await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });

		expect(created.folders).toEqual([".mayaspace", ".mayaspace/Acme-Sub"]);
	});

	test("이미 있는 파일은 create 호출 안 함", async () => {
		const { vault, created, existing } = makeVault();
		existing.add(".mayaspace");
		existing.add(".mayaspace/Acme");
		existing.add(".mayaspace/Acme/README.md");
		const api = makeApi(
			[{ id: "o1", name: "Acme" }],
			{ o1: [{ id: "f1", path: "README.md" }] },
		);

		await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });

		expect(created.files).toEqual([]);
	});

	test("createFolder가 'already exists'로 throw해도 진행 (dot-prefix 폴더 케이스)", async () => {
		const vault: VaultLike = {
			getAbstractFileByPath: () => null,
			createFolder: async (path) => {
				throw new Error(`Folder already exists: ${path}`);
			},
			create: async (path) => ({ path } as any),
		};
		const api = makeApi([{ id: "o1", name: "Acme" }], { o1: [] });

		await expect(
			syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" }),
		).resolves.toBeDefined();
	});

	test("create가 'already exists'로 throw해도 진행", async () => {
		const vault: VaultLike = {
			getAbstractFileByPath: () => null,
			createFolder: async () => ({} as any),
			create: async (path) => {
				throw new Error(`File already exists: ${path}`);
			},
		};
		const api = makeApi(
			[{ id: "o1", name: "Acme" }],
			{ o1: [{ id: "f1", path: "README.md" }] },
		);

		const result = await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });
		expect(result.files[".mayaspace/Acme/README.md"]).toEqual({ orgId: "o1", fileId: "f1" });
	});

	test("createFolder가 다른 에러로 throw하면 그대로 전파", async () => {
		const vault: VaultLike = {
			getAbstractFileByPath: () => null,
			createFolder: async () => {
				throw new Error("EACCES: permission denied");
			},
			create: async () => ({} as any),
		};
		const api = makeApi([{ id: "o1", name: "Acme" }], { o1: [] });

		await expect(
			syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" }),
		).rejects.toThrow(/permission denied/);
	});

	test("반환값: orgs(sanitized name → id) + files(vault path → {orgId,fileId})", async () => {
		const { vault } = makeVault();
		const api = makeApi(
			[{ id: "o1", name: "Acme" }, { id: "o2", name: "Globex/Sub" }],
			{
				o1: [{ id: "f1", path: "README.md" }],
				o2: [{ id: "f2", path: "notes/idea.md" }],
			},
		);

		const result = await syncOrgTrees(vault, api, { mayaspaceRoot: ".mayaspace" });

		expect(result.orgs).toEqual({ "Acme": "o1", "Globex-Sub": "o2" });
		expect(result.files).toEqual({
			".mayaspace/Acme/README.md": { orgId: "o1", fileId: "f1" },
			".mayaspace/Globex-Sub/notes/idea.md": { orgId: "o2", fileId: "f2" },
		});
	});
});

describe("syncOrgTrees — onFilePermissions", () => {
	it("tree 응답의 effective_permissions를 onFilePermissions로 전달한다", async () => {
		const api = {
			listOrgs: async () => [{ id: "o1", name: "Acme", effective_permissions: 0 }],
			getTree: async () => [{ id: "f1", path: "taeho/n.md", effective_permissions: 15 }],
		};
		const seen: Record<string, number> = {};
		await syncOrgTrees(makeVault().vault, api as any, {
			mayaspaceRoot: "MayaSpace",
			onFilePermissions: (fileId, perms) => { seen[fileId] = perms; },
		});
		expect(seen.f1).toBe(15);
	});
});

describe("syncOrgTrees — onOrgPermissions", () => {
	test("passes effective_permissions per org to the callback", async () => {
		const onOrgPermissions = jest.fn();
		const api: ApiLike = {
			listOrgs: async () => [
				{ id: "org-a", name: "A", role: "admin", effective_permissions: 31 },
				{ id: "org-b", name: "B", role: "member", effective_permissions: 1 },
			],
			getTree: async () => [],
		};
		await syncOrgTrees(makeVault().vault, api, {
			mayaspaceRoot: "MayaSpace",
			onOrgPermissions,
		});
		expect(onOrgPermissions).toHaveBeenCalledTimes(1);
		expect(onOrgPermissions).toHaveBeenCalledWith({ "org-a": 31, "org-b": 1 });
	});

	test("falls back to 0 when effective_permissions is missing", async () => {
		const onOrgPermissions = jest.fn();
		const api: ApiLike = {
			listOrgs: async () => [{ id: "org-c", name: "C", role: "member" }],
			getTree: async () => [],
		};
		await syncOrgTrees(makeVault().vault, api, {
			mayaspaceRoot: "MayaSpace",
			onOrgPermissions,
		});
		expect(onOrgPermissions).toHaveBeenCalledWith({ "org-c": 0 });
	});
});

describe("findUnmappedLocalFiles", () => {
	const root = "MayaSpace";
	const orgFolders = ["new-org", "kazan"];

	test("org 폴더 안의 매핑 안 된 로컬 파일을 반환한다", () => {
		const local = ["MayaSpace/new-org/zerosugar/제로슈가.md"];
		const known = ["MayaSpace/new-org/zerosugar/333.md"];
		expect(findUnmappedLocalFiles(local, known, root, orgFolders)).toEqual([
			"MayaSpace/new-org/zerosugar/제로슈가.md",
		]);
	});

	test("이미 알려진(서버/매핑) 파일은 제외한다", () => {
		const p = "MayaSpace/new-org/zerosugar/333.md";
		expect(findUnmappedLocalFiles([p], [p], root, orgFolders)).toEqual([]);
	});

	test("org 폴더 밖의 파일은 제외한다", () => {
		const local = [
			"Collectives/dev-test/test.md", // 다른 트리
			"MayaSpace/strayfile.md", // root 바로 아래(org 폴더 아님)
			"아이작 뉴턴.md", // vault 루트
		];
		expect(findUnmappedLocalFiles(local, [], root, orgFolders)).toEqual([]);
	});

	test("NFD 로컬과 NFC known이 같은 파일이면 제외한다(정규화 매칭)", () => {
		const nfd = "MayaSpace/new-org/zero/케도도.md".normalize("NFD");
		const nfc = "MayaSpace/new-org/zero/케도도.md".normalize("NFC");
		expect(findUnmappedLocalFiles([nfd], [nfc], root, orgFolders)).toEqual([]);
	});

	test("입력이 비면 빈 배열", () => {
		expect(findUnmappedLocalFiles([], [], root, orgFolders)).toEqual([]);
	});
});
