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
