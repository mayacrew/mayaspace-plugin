import { diffLines, diffRows, diffWords, collapseRows } from "./markdown-diff";

describe("diffLines", () => {
	test("동일한 텍스트는 모두 same", () => {
		expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual([
			{ type: "same", text: "a" },
			{ type: "same", text: "b" },
			{ type: "same", text: "c" },
		]);
	});

	test("한 줄 추가", () => {
		expect(diffLines("a\nc", "a\nb\nc")).toEqual([
			{ type: "same", text: "a" },
			{ type: "add", text: "b" },
			{ type: "same", text: "c" },
		]);
	});

	test("한 줄 삭제", () => {
		expect(diffLines("a\nb\nc", "a\nc")).toEqual([
			{ type: "same", text: "a" },
			{ type: "del", text: "b" },
			{ type: "same", text: "c" },
		]);
	});

	test("한 줄 변경은 del + add", () => {
		expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
			{ type: "same", text: "a" },
			{ type: "del", text: "b" },
			{ type: "add", text: "B" },
			{ type: "same", text: "c" },
		]);
	});

	test("빈 입력 → 추가만", () => {
		expect(diffLines("", "x\ny")).toEqual([
			{ type: "del", text: "" },
			{ type: "add", text: "x" },
			{ type: "add", text: "y" },
		]);
	});

	test("전부 삭제", () => {
		expect(diffLines("x\ny", "")).toEqual([
			{ type: "del", text: "x" },
			{ type: "del", text: "y" },
			{ type: "add", text: "" },
		]);
	});
});

describe("diffRows (줄번호 부여)", () => {
	test("변경 시 구/신 줄번호가 매겨진다", () => {
		// old: a,b,c  new: a,B,c
		expect(diffRows("a\nb\nc", "a\nB\nc")).toEqual([
			{ type: "same", text: "a", oldNo: 1, newNo: 1 },
			{ type: "del", text: "b", oldNo: 2, newNo: null },
			{ type: "add", text: "B", oldNo: null, newNo: 2 },
			{ type: "same", text: "c", oldNo: 3, newNo: 3 },
		]);
	});
});

describe("diffWords (줄 내 단어 강조)", () => {
	test("바뀐 토큰만 changed=true", () => {
		const { a, b } = diffWords("hello world", "hello there");
		expect(a).toEqual([
			{ text: "hello", changed: false },
			{ text: " ", changed: false },
			{ text: "world", changed: true },
		]);
		expect(b).toEqual([
			{ text: "hello", changed: false },
			{ text: " ", changed: false },
			{ text: "there", changed: true },
		]);
	});

	test("재구성하면 원본과 같다", () => {
		const { a, b } = diffWords("the quick fox", "the slow fox");
		expect(a.map((p) => p.text).join("")).toBe("the quick fox");
		expect(b.map((p) => p.text).join("")).toBe("the slow fox");
	});
});

describe("collapseRows (변경 없는 구간 접기)", () => {
	test("긴 동일 구간은 가운데를 접는다 (context=3)", () => {
		const rows = diffRows("a\nb\nc\nd\ne\nf\ng\nh\nX", "a\nb\nc\nd\ne\nf\ng\nh\nY");
		// 앞 8줄 동일(a~h) + 마지막 변경(X→Y). context=3이면 앞 5줄(a~e)은 접히고 f,g,h는 컨텍스트로 노출.
		const segs = collapseRows(rows, 3);
		const collapsed = segs.filter((s) => s.kind === "collapsed");
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0].rows).toHaveLength(5); // a,b,c,d,e 숨김
		// 마지막 변경 줄은 보이는 segment에 있다
		const visibleTexts = segs.filter((s) => s.kind === "rows").flatMap((s) => s.rows.map((r) => r.text));
		expect(visibleTexts).toContain("f");
		expect(visibleTexts).toContain("X");
		expect(visibleTexts).toContain("Y");
	});

	test("짧은 동일 구간은 접지 않는다", () => {
		const rows = diffRows("a\nb\nX", "a\nb\nY");
		const segs = collapseRows(rows, 3);
		expect(segs.every((s) => s.kind === "rows")).toBe(true);
	});
});
