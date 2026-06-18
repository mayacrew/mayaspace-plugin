import { httpStatusOf, isPathConflict, isQuotaExceeded, isTransientHttp } from "./http-errors";

// MayaspaceApi는 non-ok 응답을 `${method} ${path} failed: ${status} ${body}`로 던진다.
const apiError = (status: number, body = ""): Error =>
	new Error(`POST /v1/orgs/o1/files failed: ${status} ${body}`);

describe("httpStatusOf", () => {
	test("API 에러 메시지에서 상태코드를 뽑는다", () => {
		expect(httpStatusOf(apiError(429, "rate limited"))).toBe(429);
	});

	test("상태코드가 없으면(네트워크 에러) null", () => {
		expect(httpStatusOf(new Error("Failed to fetch"))).toBeNull();
	});

	test("Error가 아닌 값도 처리", () => {
		expect(httpStatusOf("boom")).toBeNull();
	});
});

describe("isPathConflict", () => {
	test("409는 충돌(멱등 처리)", () => {
		expect(isPathConflict(apiError(409, "path-conflict"))).toBe(true);
	});

	test("서버가 누설한 duplicate-key 500도 같은 원인", () => {
		expect(
			isPathConflict(apiError(500, "duplicate key value violates unique constraint file_meta_org_path_uq")),
		).toBe(true);
	});

	test("무관한 500은 충돌 아님", () => {
		expect(isPathConflict(apiError(500, "boom"))).toBe(false);
	});
});

describe("isQuotaExceeded", () => {
	test("402는 한도 초과", () => {
		expect(isQuotaExceeded(apiError(402, "quota-exceeded"))).toBe(true);
	});

	test("그 외는 아님", () => {
		expect(isQuotaExceeded(apiError(500))).toBe(false);
	});
});

describe("isTransientHttp", () => {
	test.each([429, 408, 500, 502, 503, 504])("일시적(재시도): %i", (s) => {
		expect(isTransientHttp(apiError(s))).toBe(true);
	});

	test.each([400, 401, 402, 403, 409, 413])("영구(재시도 안 함): %i", (s) => {
		expect(isTransientHttp(apiError(s))).toBe(false);
	});

	test("상태코드 없는 네트워크 에러는 일시적", () => {
		expect(isTransientHttp(new Error("Failed to fetch"))).toBe(true);
	});
});
