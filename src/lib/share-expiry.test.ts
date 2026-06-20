import { expiryToISO } from "./share-expiry";

test("none → null", () => {
	expect(expiryToISO("none", 0)).toBeNull();
});
test("7d → now+7일 ISO", () => {
	const r = expiryToISO("7d", 0);
	expect(new Date(r!).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
});
test("30d → now+30일 ISO", () => {
	const r = expiryToISO("30d", 0);
	expect(new Date(r!).getTime()).toBe(30 * 24 * 60 * 60 * 1000);
});
