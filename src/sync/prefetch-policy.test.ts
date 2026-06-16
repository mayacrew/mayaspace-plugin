import { shouldApplyPrefetch } from "./prefetch-policy";

// 백그라운드 prefetch가 ytext(서버 내용)를 로컬 vault 파일에 쓸지 결정하는 정책.
// 핵심 변경: read-only 파일은 로컬 편집이 있을 수 없으므로, non-empty여도 서버 내용으로
// 덮어써서 동기화를 유지한다. write 권한이 있는 파일만 로컬 편집 보호를 위해 빈 파일만 채운다.
describe("shouldApplyPrefetch", () => {
	test("로컬과 서버 내용이 같으면 쓰지 않는다", () => {
		expect(shouldApplyPrefetch("동일", "동일", false)).toBe(false);
		expect(shouldApplyPrefetch("동일", "동일", true)).toBe(false);
	});

	test("read-only 파일: 로컬이 비어 있으면 서버 내용을 쓴다", () => {
		expect(shouldApplyPrefetch("", "서버 내용", false)).toBe(true);
	});

	test("read-only 파일: 로컬에 내용이 있어도 서버 내용으로 덮어쓴다 (보호할 로컬 편집 없음)", () => {
		expect(shouldApplyPrefetch("오래된 로컬 본문", "서버 최신 본문", false)).toBe(true);
	});

	test("writable 파일: 로컬이 비어 있으면 서버 내용을 쓴다 (placeholder 채움)", () => {
		expect(shouldApplyPrefetch("", "서버 내용", true)).toBe(true);
	});

	test("writable 파일: 로컬에 내용이 있으면 쓰지 않는다 (로컬 편집 보호, 머지는 yCollab attach에 위임)", () => {
		expect(shouldApplyPrefetch("로컬 편집본", "서버 본문", true)).toBe(false);
	});
});
