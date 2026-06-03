/**
 * Awareness `user` field — name + deterministic color.
 *
 * yCollab renders remote cursor labels using `user.name` and the cursor color
 * using `user.color`/`user.colorLight`. Same email → same hue across sessions
 * so peers stay visually consistent across reconnects.
 */

export interface PeerIdentity {
	name: string;
	color: string;
	colorLight: string;
}

export function makePeerIdentity(
	displayName: string | null,
	email: string | null,
	handle?: string | null,
): PeerIdentity {
	const name = pickName(displayName, email, handle);
	const hue = hueFromString(name);
	return {
		name,
		color: `hsl(${hue}, 70%, 50%)`,
		colorLight: `hsla(${hue}, 70%, 50%, 0.2)`,
	};
}

// email-first: 검증된 서버 identity(email/handle)를 사용자 지정 displayName보다 우선한다.
// displayName은 타인의 이름으로 설정될 수 있어 표시 신원 고정(C4) 목적으로 신뢰하지 않는다.
function pickName(displayName: string | null, email: string | null, handle?: string | null): string {
	if (email) return email;
	if (handle && handle.trim()) return handle.trim();
	if (displayName && displayName.trim()) return displayName.trim();
	return "Anonymous";
}

function hueFromString(s: string): number {
	let hash = 0;
	for (const c of s) hash = (hash * 31 + c.charCodeAt(0)) | 0;
	return Math.abs(hash) % 360;
}
