import { diffLines } from "./markdown-diff";

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
