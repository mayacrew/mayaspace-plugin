/**
 * Vault 이벤트별 권한 사전 가드.
 *
 * 각 헬퍼는 effective bits를 받아 (a) 허용 여부 (b) 거부 사유 (c) 표시용 메시지를 반환한다.
 * 호출 측은 결과만 보고 토스트 + 동기화 스킵 결정을 한다. 비트 의미는
 * server `permissions.ts`와 동일 — `lib/permissions.ts`의 상수를 사용한다.
 */

import { READ, UPDATE, CREATE, DELETE, can } from "../lib/permissions";

export type GuardReason = "read" | "update" | "create" | "delete" | "move";

export interface GuardResult {
	allowed: boolean;
	reason?: GuardReason;
	message?: string;
}

const OK: GuardResult = { allowed: true };

export function checkRead(perms: number): GuardResult {
	return can(perms, READ)
		? OK
		: { allowed: false, reason: "read", message: "MayaSpace: 읽기 권한이 없습니다." };
}

export function checkCreate(perms: number): GuardResult {
	return can(perms, CREATE)
		? OK
		: { allowed: false, reason: "create", message: "MayaSpace: 생성 권한이 없습니다." };
}

export function checkUpdate(perms: number): GuardResult {
	return can(perms, UPDATE)
		? OK
		: { allowed: false, reason: "update", message: "MayaSpace: 편집 권한이 없습니다." };
}

export function checkDelete(perms: number): GuardResult {
	return can(perms, DELETE)
		? OK
		: { allowed: false, reason: "delete", message: "MayaSpace: 삭제 권한이 없습니다." };
}

/**
 * 이동(rename) 안→안 케이스는 newPath에 CREATE + oldPath에 DELETE가 둘 다 필요.
 * 같은 org 안에서는 두 path 모두 같은 effective bits이므로 단일 perms로 충분하다.
 */
export function checkMove(perms: number): GuardResult {
	if (!can(perms, CREATE) || !can(perms, DELETE)) {
		return {
			allowed: false,
			reason: "move",
			message: "MayaSpace: 이동 권한(생성+삭제)이 없습니다.",
		};
	}
	return OK;
}
