/**
 * TokenStorage backed by Obsidian's plugin.saveData / loadData.
 *
 * Tokens live alongside other plugin settings in
 * <vault>/.obsidian/plugins/mayaspace/data.json — Obsidian's native store, no
 * external secret-manager dependency.
 */

import type { TokenSet, TokenStorage } from "./mayaspace-auth";

export interface SettingsHost {
	getTokenSet(): TokenSet | null;
	setTokenSet(tokens: TokenSet | null): Promise<void>;
}

export class PluginTokenStorage implements TokenStorage {
	constructor(private host: SettingsHost) {}

	async save(tokens: TokenSet): Promise<void> {
		await this.host.setTokenSet(tokens);
	}

	async load(): Promise<TokenSet | null> {
		return this.host.getTokenSet();
	}

	async clear(): Promise<void> {
		await this.host.setTokenSet(null);
	}
}
