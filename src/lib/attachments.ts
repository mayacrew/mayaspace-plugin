/**
 * 이미지 첨부 1차 범위 (PRD docs/image-attachments-prd-2026-06-12.md).
 * 분기 기준은 "이미지 확장자 목록"이다 — "비-md 전체"로 가르면 .canvas 등
 * 기존 텍스트 동기화 동작을 건드리므로 금지.
 */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function isImagePath(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** img-<YYYYMMDDHHmmss>-<rand4>.<ext> — vault 전역 유니크 → ![[basename]] 링크가 안전하다. */
export function attachmentFileName(ext: string, now: Date, rand: string): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	return `img-${ts}-${rand}.${ext.toLowerCase()}`;
}

export function makeRand4(): string {
	return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** btoa는 Latin1 전용이라 바이트 배열을 청크로 문자열화해 인코딩한다. */
export function bytesToBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export type DropDecision =
	| { kind: "ignore" } // 우리 관할 아님 → Obsidian 기본 동작에 맡긴다
	| { kind: "block"; message: string } // 관할인데 거부 → Notice + preventDefault
	| { kind: "save"; folder: string; vaultPath: string; linkText: string };

export function decideImageDrop(opts: {
	notePath: string | null;
	inOrgFolder: boolean;
	canCreate: boolean;
	fileName: string;
	fileSize: number;
	now: Date;
	rand: string;
}): DropDecision {
	if (!opts.notePath || !opts.inOrgFolder) return { kind: "ignore" };

	const dot = opts.fileName.lastIndexOf(".");
	const ext = dot < 0 ? "" : opts.fileName.slice(dot + 1).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext)) return { kind: "ignore" };

	if (opts.fileSize > MAX_IMAGE_BYTES) {
		return { kind: "block", message: "MayaSpace: 이미지가 20MiB를 초과해 첨부할 수 없습니다." };
	}
	if (!opts.canCreate) {
		return { kind: "block", message: "MayaSpace: 이 폴더에 첨부할 권한이 없습니다." };
	}

	const slash = opts.notePath.lastIndexOf("/");
	const noteDir = slash < 0 ? "" : opts.notePath.slice(0, slash);
	const folder = noteDir ? `${noteDir}/attachments` : "attachments";
	const name = attachmentFileName(ext, opts.now, opts.rand);
	return {
		kind: "save",
		folder,
		vaultPath: `${folder}/${name}`,
		linkText: `![[${name}]]`,
	};
}
