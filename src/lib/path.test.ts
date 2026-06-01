import { parseMayaspacePath, sanitizeFolderName } from "./path";

describe("parseMayaspacePath", () => {
	test("정상: <root>/<org>/<relPath>", () => {
		expect(parseMayaspacePath(".mayaspace/work/notes/idea.md", ".mayaspace")).toEqual({
			orgName: "work",
			relPath: "notes/idea.md",
		});
	});

	test("org 바로 아래 단일 파일", () => {
		expect(parseMayaspacePath(".mayaspace/work/idea.md", ".mayaspace")).toEqual({
			orgName: "work",
			relPath: "idea.md",
		});
	});

	test("mayaspaceRoot 자체는 null", () => {
		expect(parseMayaspacePath(".mayaspace", ".mayaspace")).toBeNull();
	});

	test("mayaspaceRoot 바로 아래 (org 폴더만)는 null (파일이 아님)", () => {
		expect(parseMayaspacePath(".mayaspace/work", ".mayaspace")).toBeNull();
	});

	test("mayaspaceRoot 밖 경로는 null", () => {
		expect(parseMayaspacePath("Daily/today.md", ".mayaspace")).toBeNull();
		expect(parseMayaspacePath(".obsidian/config.json", ".mayaspace")).toBeNull();
	});

	test("mayaspaceRoot가 / 로 끝나도 정상 처리", () => {
		expect(parseMayaspacePath(".mayaspace/work/idea.md", ".mayaspace/")).toEqual({
			orgName: "work",
			relPath: "idea.md",
		});
	});

	test("mayaspaceRoot가 비슷한 prefix(예: .mayaspace2)는 매칭 안됨", () => {
		expect(parseMayaspacePath(".mayaspace2/work/idea.md", ".mayaspace")).toBeNull();
	});

	test("커스텀 mayaspaceRoot", () => {
		expect(parseMayaspacePath("MyTeams/alpha/doc.md", "MyTeams")).toEqual({
			orgName: "alpha",
			relPath: "doc.md",
		});
	});

	test("orgName이 공백 포함 (sanitize는 caller가 처리)", () => {
		expect(parseMayaspacePath(".mayaspace/Big Org/file.md", ".mayaspace")).toEqual({
			orgName: "Big Org",
			relPath: "file.md",
		});
	});
});

describe("sanitizeFolderName", () => {
	test("슬래시는 dash로 치환", () => {
		expect(sanitizeFolderName("Acme/Sub")).toBe("Acme-Sub");
	});

	test("슬래시 없으면 그대로", () => {
		expect(sanitizeFolderName("Acme")).toBe("Acme");
	});
});
