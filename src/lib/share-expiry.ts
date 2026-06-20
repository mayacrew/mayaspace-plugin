export type ExpiryOption = "none" | "7d" | "30d";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 만료 옵션을 ISO 문자열로. nowMs를 받아 결정적(테스트 용이). */
export function expiryToISO(option: ExpiryOption, nowMs: number): string | null {
	if (option === "none") return null;
	const days = option === "7d" ? 7 : 30;
	return new Date(nowMs + days * DAY_MS).toISOString();
}
