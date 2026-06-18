/**
 * MayaspaceApi가 던지는 에러를 분류한다. rawRequest는 non-ok 응답을
 * `${method} ${path} failed: ${status} ${body}` 형식의 Error로 던지므로,
 * 메시지에서 상태코드를 읽어 재시도/스킵 여부를 판단한다.
 *
 * 업로드 큐(upload-queue)가 이 분류로 "백오프 재시도 vs 포기"를 결정한다.
 */

/** 에러 메시지에서 HTTP 상태코드를 뽑는다. 없으면(네트워크/타임아웃) null. */
export function httpStatusOf(err: unknown): number | null {
	const msg = err instanceof Error ? err.message : String(err);
	const m = msg.match(/failed:\s*(\d{3})\b/);
	return m ? Number(m[1]) : null;
}

/**
 * 같은 경로가 이미 있는 경우 — 409, 또는 일부 서버가 누설하는 unique-violation
 * (500 + duplicate key). 멱등하게 "이미 존재"로 처리한다(재시도/실패 아님).
 */
export function isPathConflict(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		httpStatusOf(err) === 409 ||
		/path-conflict/.test(msg) ||
		/duplicate key/i.test(msg) ||
		/file_meta_org_path_uq/.test(msg)
	);
}

/** 402 quota-exceeded — 한도 초과라 재시도해도 소용없다(업그레이드/정리 필요). */
export function isQuotaExceeded(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return httpStatusOf(err) === 402 || /quota-exceeded/.test(msg);
}

/**
 * 일시적 실패 — 백오프 후 재시도하면 성공할 수 있다. 429(rate-limit)·408·5xx,
 * 그리고 상태코드가 없는 네트워크/타임아웃 에러를 포함한다.
 * 401(인증)·402(한도)·403(권한)·409(충돌)·413(크기)은 재시도 대상이 아니다.
 */
export function isTransientHttp(err: unknown): boolean {
	const status = httpStatusOf(err);
	if (status === null) return true;
	return status === 429 || status === 408 || (status >= 500 && status <= 599);
}
