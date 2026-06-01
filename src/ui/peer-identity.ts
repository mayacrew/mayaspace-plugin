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

export function makePeerIdentity(displayName: string | null, email: string | null): PeerIdentity {
	const name = pickName(displayName, email);
	const hue = hueFromString(name);
	return {
		name,
		color: `hsl(${hue}, 70%, 50%)`,
		colorLight: `hsla(${hue}, 70%, 50%, 0.2)`,
	};
}

function pickName(displayName: string | null, email: string | null): string {
	if (displayName && displayName.trim()) return displayName.trim();
	if (email) return email.split("@")[0];
	return "Anonymous";
}

function hueFromString(s: string): number {
	let hash = 0;
	for (const c of s) hash = (hash * 31 + c.charCodeAt(0)) | 0;
	return Math.abs(hash) % 360;
}
