import { deriveFolderContentStates } from "./content-status";

describe("deriveFolderContentStates", () => {
	it("단일 파일이 local이면 모든 조상 폴더도 local", () => {
		const out = deriveFolderContentStates(["a/b/note.md"], { "a/b/note.md": "local" });
		expect(out).toEqual({ a: "local", "a/b": "local" });
	});

	it("placeholder 자식이 local 형제를 이긴다 (안 받은 게 있음)", () => {
		const out = deriveFolderContentStates(
			["dev/a.md", "dev/b.md"],
			{ "dev/a.md": "placeholder", "dev/b.md": "local" },
		);
		expect(out.dev).toBe("placeholder");
	});

	it("placeholder가 hydrating을 이긴다 (아직 시작도 안 한 게 우선)", () => {
		const out = deriveFolderContentStates(
			["dev/a.md", "dev/b.md"],
			{ "dev/a.md": "placeholder", "dev/b.md": "hydrating" },
		);
		expect(out.dev).toBe("placeholder");
	});

	it("hydrating이 local을 이긴다 (받는 중 표시)", () => {
		const out = deriveFolderContentStates(
			["dev/a.md", "dev/b.md"],
			{ "dev/a.md": "hydrating", "dev/b.md": "local" },
		);
		expect(out.dev).toBe("hydrating");
	});

	it("상태 누락은 placeholder로 취급한다", () => {
		const out = deriveFolderContentStates(["dev/a.md"], {});
		expect(out.dev).toBe("placeholder");
	});

	it("깊은 파일의 상태가 모든 조상 폴더로 전파된다", () => {
		const out = deriveFolderContentStates(
			["root/mid/leaf/x.md"],
			{ "root/mid/leaf/x.md": "hydrating" },
		);
		expect(out).toEqual({
			root: "hydrating",
			"root/mid": "hydrating",
			"root/mid/leaf": "hydrating",
		});
	});

	it("형제 폴더는 서로의 상태에 영향을 주지 않는다", () => {
		const out = deriveFolderContentStates(
			["org/dev/a.md", "org/private/b.md"],
			{ "org/dev/a.md": "placeholder", "org/private/b.md": "local" },
		);
		expect(out["org/dev"]).toBe("placeholder");
		expect(out["org/private"]).toBe("local");
		// 공통 조상은 더 높은 우선순위(placeholder)를 집계한다
		expect(out.org).toBe("placeholder");
	});
});
