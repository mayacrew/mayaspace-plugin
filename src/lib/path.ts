/**
 * Parse a vault-relative path into MayaSpace coordinates.
 *
 * Layout convention:
 *   <mayaspaceRoot>/<orgName>/<relPath>
 *
 * Returns null when the path is outside the mayaspace root, or when the path
 * resolves to the root itself or just an org folder (no file).
 */

export interface MayaspacePath {
	orgName: string;
	relPath: string;
}

export function parseMayaspacePath(vaultPath: string, mayaspaceRoot: string): MayaspacePath | null {
	const root = mayaspaceRoot.replace(/\/+$/, "");
	if (vaultPath === root) return null;
	if (!vaultPath.startsWith(root + "/")) return null;

	const rest = vaultPath.slice(root.length + 1);
	const slash = rest.indexOf("/");
	if (slash < 0) return null;

	const orgName = rest.slice(0, slash);
	const relPath = rest.slice(slash + 1);
	if (!orgName || !relPath) return null;
	return { orgName, relPath };
}

// Obsidian vault path segment can't contain '/'.
export function sanitizeFolderName(name: string): string {
	return name.replace(/\//g, "-");
}

// Server-relative paths arrive over SSE / REST and get joined onto the vault
// root before vault.create / rename. A hostile or buggy server could send
// '../', a drive prefix, or a reserved segment to escape the vault. Mirror the
// server's canonical rules (common/path/canonical-path.ts) so a path that the
// server would reject can't slip through the plugin either.
const RESERVED_SEGMENTS = new Set([".trash"]);
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

export class InvalidServerPathError extends Error {
	constructor(value: string, reason: string) {
		super(`Invalid server path (${reason}): ${value}`);
	}
}

/**
 * Normalise a server-relative path to canonical form and reject traversal /
 * absolute / drive-prefixed / reserved inputs. Empty segments ('a//b', 'a/./b')
 * are absorbed. Throws InvalidServerPathError when the path can't be trusted.
 */
export function canonicalServerPath(raw: string): string {
	if (raw.includes("\\")) throw new InvalidServerPathError(raw, "backslash not allowed");
	if (WINDOWS_DRIVE.test(raw)) throw new InvalidServerPathError(raw, "drive prefix not allowed");
	if (raw.startsWith("/")) throw new InvalidServerPathError(raw, "absolute path not allowed");

	const out: string[] = [];
	for (const seg of raw.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new InvalidServerPathError(raw, "parent traversal not allowed");
		if (RESERVED_SEGMENTS.has(seg)) throw new InvalidServerPathError(raw, `reserved segment "${seg}"`);
		out.push(seg);
	}
	if (out.length === 0) throw new InvalidServerPathError(raw, "empty path");
	return out.join("/");
}
