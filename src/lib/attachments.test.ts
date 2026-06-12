import {
	isImagePath,
	attachmentFileName,
	makeRand4,
	bytesToBase64,
	decideImageDrop,
	MAX_IMAGE_BYTES,
} from "./attachments";

describe("isImagePath", () => {
	it("1차 이미지 확장자만 true", () => {
		expect(isImagePath("a/b.png")).toBe(true);
		expect(isImagePath("a/B.JPG")).toBe(true);
		expect(isImagePath("a/b.webp")).toBe(true);
		expect(isImagePath("a/b.svg")).toBe(true);
		expect(isImagePath("a/b.md")).toBe(false);
		expect(isImagePath("a/b.canvas")).toBe(false);
		expect(isImagePath("noext")).toBe(false);
	});
});

describe("attachmentFileName", () => {
	it("img-<ts>-<rand>.<ext> 형식", () => {
		const name = attachmentFileName("png", new Date(2026, 5, 12, 9, 30, 5), "ab3z");
		expect(name).toBe("img-20260612093005-ab3z.png");
	});
});

describe("makeRand4", () => {
	it("base36 4자", () => {
		expect(makeRand4()).toMatch(/^[a-z0-9]{4}$/);
	});
});

describe("bytesToBase64", () => {
	it("바이트를 보존한다 (atob round-trip)", () => {
		const bytes = new Uint8Array([0, 1, 255, 128, 37]);
		const b64 = bytesToBase64(bytes.buffer);
		const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		expect(Array.from(back)).toEqual(Array.from(bytes));
	});
});

describe("decideImageDrop", () => {
	const base = {
		notePath: "MayaSpace/mark/dev/회의록.md",
		inOrgFolder: true,
		canCreate: true,
		fileName: "스크린샷.png",
		fileSize: 1024,
		now: new Date(2026, 5, 12, 9, 30, 5),
		rand: "ab3z",
	};

	it("org 폴더 안 + 이미지 + 권한 → save (노트 옆 attachments/)", () => {
		const d = decideImageDrop(base);
		expect(d).toEqual({
			kind: "save",
			folder: "MayaSpace/mark/dev/attachments",
			vaultPath: "MayaSpace/mark/dev/attachments/img-20260612093005-ab3z.png",
			linkText: "![[img-20260612093005-ab3z.png]]",
		});
	});

	it("org 폴더 밖 노트 → ignore (Obsidian 기본 동작)", () => {
		expect(decideImageDrop({ ...base, inOrgFolder: false }).kind).toBe("ignore");
		expect(decideImageDrop({ ...base, notePath: null }).kind).toBe("ignore");
	});

	it("이미지 확장자 아님 → ignore", () => {
		expect(decideImageDrop({ ...base, fileName: "doc.pdf" }).kind).toBe("ignore");
	});

	it("20MiB 초과 → block + 메시지", () => {
		const d = decideImageDrop({ ...base, fileSize: MAX_IMAGE_BYTES + 1 });
		expect(d.kind).toBe("block");
		if (d.kind === "block") expect(d.message).toContain("20MiB");
	});

	it("CREATE 권한 없음 → block", () => {
		const d = decideImageDrop({ ...base, canCreate: false });
		expect(d.kind).toBe("block");
		if (d.kind === "block") expect(d.message).toContain("권한");
	});
});
