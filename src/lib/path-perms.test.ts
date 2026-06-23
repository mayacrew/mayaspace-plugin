import { inheritedPermsForPath } from "./path-perms";

const READ = 1;
const CREATE = 4;
const RUCD = 1 | 2 | 4 | 8; // 15

describe("inheritedPermsForPath", () => {
	const orgId = "o1";

	it("같은 폴더 형제의 권한을 쓴다", () => {
		const maps = { "M/o/bulk/a.md": { orgId, fileId: "fa" } };
		expect(inheritedPermsForPath(orgId, "M/o/bulk/b.md", maps, { fa: RUCD }, READ)).toBe(RUCD);
	});

	it("형제가 없으면 가장 가까운 조상 폴더 권한을 물려받는다 (하위폴더 드래그 회귀 수정)", () => {
		const maps = { "M/o/bulk/a.md": { orgId, fileId: "fa" } };
		// 새 하위폴더 sub/deep/ 엔 형제가 없지만 조상 bulk/ 의 CREATE를 상속해야 한다.
		expect(
			inheritedPermsForPath(orgId, "M/o/bulk/sub/deep/0001.md", maps, { fa: CREATE | READ }, READ),
		).toBe(CREATE | READ);
	});

	it("더 가까운(깊은) 조상이 더 먼 조상을 이긴다", () => {
		const maps = {
			"M/o/root.md": { orgId, fileId: "fr" }, //        조상 M/o (READ)
			"M/o/bulk/a.md": { orgId, fileId: "fa" }, //      더 가까운 조상 M/o/bulk (RUCD)
		};
		expect(inheritedPermsForPath(orgId, "M/o/bulk/sub/x.md", maps, { fr: READ, fa: RUCD }, 0)).toBe(RUCD);
	});

	it("조상이 전혀 없으면 org 루트 권한으로 폴백", () => {
		expect(inheritedPermsForPath(orgId, "M/o/bulk/x.md", {}, {}, READ)).toBe(READ);
	});

	it("다른 org의 매핑은 무시한다", () => {
		const maps = { "M/o/bulk/a.md": { orgId: "other", fileId: "fa" } };
		expect(inheritedPermsForPath(orgId, "M/o/bulk/b.md", maps, { fa: RUCD }, READ)).toBe(READ);
	});

	it("권한 캐시에 없는 매핑은 건너뛴다", () => {
		const maps = {
			"M/o/bulk/a.md": { orgId, fileId: "fa" }, // 권한 캐시 없음
			"M/o/x.md": { orgId, fileId: "fx" }, //      조상, 권한 있음
		};
		expect(inheritedPermsForPath(orgId, "M/o/bulk/sub/y.md", maps, { fx: CREATE }, 0)).toBe(CREATE);
	});
});
