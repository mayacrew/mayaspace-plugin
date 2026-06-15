import { ancestorFolders, deriveFolderStatuses } from "./folder-status";

describe("ancestorFolders", () => {
	it("파일 경로의 모든 상위 폴더를 얕은→깊은 순으로 돌려준다", () => {
		expect(ancestorFolders("MayaSpace/mark/dev/note.md")).toEqual([
			"MayaSpace",
			"MayaSpace/mark",
			"MayaSpace/mark/dev",
		]);
	});

	it("vault 루트 파일은 상위 폴더가 없다", () => {
		expect(ancestorFolders("note.md")).toEqual([]);
	});
});

describe("deriveFolderStatuses", () => {
	it("단일 파일이 idle이면 모든 조상 폴더도 idle", () => {
		const out = deriveFolderStatuses(["a/b/note.md"], { "a/b/note.md": "idle" });
		expect(out).toEqual({ a: "idle", "a/b": "idle" });
	});

	it("conflict 자식이 connected 형제를 이긴다", () => {
		const out = deriveFolderStatuses(
			["dev/a.md", "dev/b.md"],
			{ "dev/a.md": "conflict", "dev/b.md": "connected" },
		);
		expect(out.dev).toBe("conflict");
	});

	it("syncing이 connected를 이긴다", () => {
		const out = deriveFolderStatuses(
			["dev/a.md", "dev/b.md"],
			{ "dev/a.md": "syncing", "dev/b.md": "connected" },
		);
		expect(out.dev).toBe("syncing");
	});

	it("offline이 connected를 이긴다 (동기화 안 된 자식을 드러낸다)", () => {
		const out = deriveFolderStatuses(
			["dev/a.md", "dev/b.md"],
			{ "dev/a.md": "offline", "dev/b.md": "connected" },
		);
		expect(out.dev).toBe("offline");
	});

	it("connected가 idle을 이긴다 (활동 중 신호)", () => {
		const out = deriveFolderStatuses(
			["dev/a.md", "dev/b.md"],
			{ "dev/a.md": "connected", "dev/b.md": "idle" },
		);
		expect(out.dev).toBe("connected");
	});

	it("상태 누락은 idle로 취급한다", () => {
		const out = deriveFolderStatuses(["dev/a.md"], {});
		expect(out.dev).toBe("idle");
	});

	it("깊은 파일의 상태가 모든 조상 폴더로 전파된다", () => {
		const out = deriveFolderStatuses(
			["root/mid/leaf/x.md"],
			{ "root/mid/leaf/x.md": "syncing" },
		);
		expect(out).toEqual({
			root: "syncing",
			"root/mid": "syncing",
			"root/mid/leaf": "syncing",
		});
	});

	it("형제 폴더는 서로의 상태에 영향을 주지 않는다", () => {
		const out = deriveFolderStatuses(
			["org/dev/a.md", "org/private/b.md"],
			{ "org/dev/a.md": "conflict", "org/private/b.md": "idle" },
		);
		expect(out["org/dev"]).toBe("conflict");
		expect(out["org/private"]).toBe("idle");
		// 공통 조상은 더 높은 우선순위(conflict)를 집계한다
		expect(out.org).toBe("conflict");
	});
});
