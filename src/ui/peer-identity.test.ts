import { makePeerIdentity } from "./peer-identity";

describe("makePeerIdentity — C4 email-first", () => {
	test("email이 있으면 email을 name으로 사용", () => {
		const id = makePeerIdentity("Alice", "alice@example.com");
		expect(id.name).toBe("alice@example.com");
	});

	test("email이 없고 handle이 있으면 handle 사용", () => {
		const id = makePeerIdentity("Alice", null, "alice-handle");
		expect(id.name).toBe("alice-handle");
	});

	test("email·handle 없고 displayName이 있으면 displayName 사용", () => {
		const id = makePeerIdentity("Alice", null, null);
		expect(id.name).toBe("Alice");
	});

	test("모두 없으면 Anonymous", () => {
		const id = makePeerIdentity(null, null, null);
		expect(id.name).toBe("Anonymous");
	});

	test("displayName이 있어도 email이 우선", () => {
		const id = makePeerIdentity("Impersonator", "real@example.com");
		expect(id.name).toBe("real@example.com");
	});

	test("같은 email은 항상 같은 hue → 같은 color", () => {
		const a = makePeerIdentity("A", "shared@example.com");
		const b = makePeerIdentity("B", "shared@example.com");
		expect(a.color).toBe(b.color);
		expect(a.colorLight).toBe(b.colorLight);
	});

	test("color는 hsl 형식", () => {
		const id = makePeerIdentity(null, "x@example.com");
		expect(id.color).toMatch(/^hsl\(\d+, 70%, 50%\)$/);
		expect(id.colorLight).toMatch(/^hsla\(\d+, 70%, 50%, 0\.2\)$/);
	});
});
