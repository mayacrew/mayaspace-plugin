/**
 * TokenStorage backed by Obsidian's plugin.saveData / loadData.
 *
 * Secret hygiene (#8):
 *   - The access token is short-lived and kept in memory only; it is never
 *     written to <vault>/.obsidian/plugins/mayaspace/data.json.
 *   - The refresh token is the long-lived secret. When Electron safeStorage is
 *     available we persist it encrypted (ciphertext only). When it is not, we
 *     fall back to plaintext so login still survives a restart — see the WHY
 *     note on the fallback branch.
 *
 * The persisted shape stays a TokenSet so callers and settings typing are
 * unchanged. After a restart only the refresh token is recovered, so the
 * loaded set carries an empty accessToken and expiresAt=0, which forces the
 * auth layer to refresh before first use.
 */

import type { TokenSet, TokenStorage } from "./mayaspace-auth";

export interface SettingsHost {
	getTokenSet(): TokenSet | null;
	setTokenSet(tokens: TokenSet | null): Promise<void>;
}

interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plain: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

/** Marks a refresh token persisted as base64 safeStorage ciphertext. */
const ENC_PREFIX = "enc:v1:";

function getSafeStorage(): SafeStorage | null {
	try {
		// Electron is externalized in the bundle and resolved by Obsidian's
		// renderer at runtime; safeStorage lives on the main process and is
		// reached via @electron/remote.
		const electron = require("electron");
		const safeStorage: SafeStorage | undefined =
			electron?.remote?.safeStorage ?? require("@electron/remote")?.safeStorage;
		if (safeStorage?.isEncryptionAvailable()) return safeStorage;
		return null;
	} catch {
		return null;
	}
}

function encryptRefreshToken(refreshToken: string): string {
	const safeStorage = getSafeStorage();
	if (safeStorage) {
		const ciphertext = safeStorage.encryptString(refreshToken).toString("base64");
		return ENC_PREFIX + ciphertext;
	}
	// Fallback: safeStorage unavailable (e.g. Linux without a keyring). We
	// persist the refresh token in plaintext so the session survives a restart;
	// data.json is then a sensitive file. This is the documented Option B.
	console.warn(
		"MayaSpace: secure storage unavailable; refresh token is persisted in plaintext in data.json.",
	);
	return refreshToken;
}

function decryptRefreshToken(stored: string): string | null {
	if (!stored.startsWith(ENC_PREFIX)) return stored;
	const safeStorage = getSafeStorage();
	if (!safeStorage) return null;
	try {
		const ciphertext = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
		return safeStorage.decryptString(ciphertext);
	} catch {
		return null;
	}
}

export class PluginTokenStorage implements TokenStorage {
	constructor(private host: SettingsHost) {}

	async save(tokens: TokenSet): Promise<void> {
		await this.host.setTokenSet({
			accessToken: "",
			refreshToken: encryptRefreshToken(tokens.refreshToken),
			expiresAt: 0,
		});
	}

	async load(): Promise<TokenSet | null> {
		const stored = this.host.getTokenSet();
		if (!stored) return null;

		const refreshToken = decryptRefreshToken(stored.refreshToken);
		if (!refreshToken) return null;

		return { accessToken: "", refreshToken, expiresAt: 0 };
	}

	async clear(): Promise<void> {
		await this.host.setTokenSet(null);
	}
}
