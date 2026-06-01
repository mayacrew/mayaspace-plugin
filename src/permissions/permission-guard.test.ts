import { READ, UPDATE, CREATE, DELETE } from "../lib/permissions";
import { checkRead, checkCreate, checkUpdate, checkDelete, checkMove } from "./permission-guard";

describe("permission guards", () => {
	test("checkRead allows when READ bit set", () => {
		expect(checkRead(READ)).toEqual({ allowed: true });
		expect(checkRead(0)).toMatchObject({ allowed: false, reason: "read" });
	});

	test("checkCreate allows when CREATE bit set", () => {
		expect(checkCreate(READ | CREATE)).toEqual({ allowed: true });
	});

	test("checkCreate blocks when CREATE missing", () => {
		const r = checkCreate(READ | UPDATE);
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("create");
		expect(r.message).toMatch(/생성/);
	});

	test("checkUpdate blocks when UPDATE missing", () => {
		expect(checkUpdate(READ).allowed).toBe(false);
		expect(checkUpdate(READ | UPDATE).allowed).toBe(true);
	});

	test("checkDelete blocks when DELETE missing", () => {
		expect(checkDelete(READ).allowed).toBe(false);
		expect(checkDelete(READ | DELETE).allowed).toBe(true);
	});

	test("checkMove needs both CREATE and DELETE", () => {
		expect(checkMove(READ | CREATE).allowed).toBe(false);
		expect(checkMove(READ | DELETE).allowed).toBe(false);
		expect(checkMove(CREATE | DELETE).allowed).toBe(true);
	});

	test("checkMove with all bits is allowed", () => {
		expect(checkMove(READ | UPDATE | CREATE | DELETE)).toEqual({ allowed: true });
	});
});
