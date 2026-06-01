/**
 * MayaSpace OAuth Device Flow + token lifecycle.
 *
 * Flow:
 *   1. startDeviceFlow() → POST /v1/auth/device/init → { device_code, user_code, verification_uri, interval }
 *   2. UI shows user_code + opens verification_uri
 *   3. pollDeviceFlow(deviceCode) repeated every `interval` seconds
 *      - 200 → tokens saved, authenticated
 *      - 428 → DeviceFlowPendingError (keep polling)
 *      - 410 → DeviceFlowExpiredError (give up)
 *   4. getValidAccessToken() auto-refreshes when token is near expiry
 */

import type { Fetcher } from "../api/mayaspace-http";

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch millis
}

export interface TokenStorage {
	save(tokens: TokenSet): Promise<void>;
	load(): Promise<TokenSet | null>;
	clear(): Promise<void>;
}

export class InMemoryTokenStorage implements TokenStorage {
	private tokens: TokenSet | null = null;
	async save(tokens: TokenSet): Promise<void> { this.tokens = tokens; }
	async load(): Promise<TokenSet | null> { return this.tokens; }
	async clear(): Promise<void> { this.tokens = null; }
}

export interface DeviceFlowSession {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSec: number;
	expiresInSec: number;
}

export class DeviceFlowPendingError extends Error {
	constructor() { super("device flow approval pending"); }
}
export class DeviceFlowExpiredError extends Error {
	constructor() { super("device flow expired"); }
}
export class AuthRefreshFailedError extends Error {
	constructor(public status: number) { super(`refresh failed: ${status}`); }
}
export class InvalidCredentialsError extends Error {
	constructor() { super("invalid email or password"); }
}
export class EmailAlreadyRegisteredError extends Error {
	constructor() { super("email already registered"); }
}
export class SignupNotAllowedError extends Error {
	constructor() { super("signup not allowed in current mode"); }
}

interface DeviceInitResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

const REFRESH_THRESHOLD_MS = 30_000;

export class MayaspaceAuth {
	constructor(
		private baseUrl: string,
		private fetcher: Fetcher,
		private storage: TokenStorage,
		private now: () => number = Date.now,
	) {}

	private _cachedTokens: TokenSet | null | undefined;

	async startDeviceFlow(deviceName: string): Promise<DeviceFlowSession> {
		const res = await this.fetcher({
			method: "POST",
			url: `${this.baseUrl}/v1/auth/device/init`,
			headers: { "Content-Type": "application/json", "Accept": "application/json" },
			body: JSON.stringify({ device_name: deviceName }),
		});
		if (!res.ok) throw new Error(`device init failed: ${res.status}`);
		const body = await res.json<DeviceInitResponse>();
		return {
			deviceCode: body.device_code,
			userCode: body.user_code,
			verificationUri: body.verification_uri,
			intervalSec: body.interval,
			expiresInSec: body.expires_in,
		};
	}

	async pollDeviceFlow(deviceCode: string): Promise<void> {
		const res = await this.fetcher({
			method: "GET",
			url: `${this.baseUrl}/v1/auth/device/poll?device_code=${encodeURIComponent(deviceCode)}`,
			headers: { "Accept": "application/json" },
		});
		if (res.status === 428) throw new DeviceFlowPendingError();
		if (res.status === 410) throw new DeviceFlowExpiredError();
		if (!res.ok) throw new Error(`device poll failed: ${res.status}`);
		const body = await res.json<TokenResponse>();
		await this.storeTokens(body);
	}

	/**
	 * One-shot password login. Skips the device-flow browser round-trip —
	 * the plugin is a trusted client so we can take credentials directly.
	 * Password is never persisted: only the returned tokens go to storage.
	 */
	async loginWithPassword(email: string, password: string, deviceName: string): Promise<void> {
		const res = await this.fetcher({
			method: "POST",
			url: `${this.baseUrl}/v1/auth/login`,
			headers: { "Content-Type": "application/json", "Accept": "application/json" },
			body: JSON.stringify({ email, password, device_name: deviceName }),
		});
		if (res.status === 401) throw new InvalidCredentialsError();
		if (!res.ok) throw new Error(`login failed: ${res.status}`);
		const body = await res.json<TokenResponse>();
		await this.storeTokens(body);
	}

	/**
	 * 회원가입. 계정을 만들고 토큰을 받아 바로 로그인 상태가 된다.
	 * token(초대) 또는 orgName(새 조직) 중 하나를 준다. 비밀번호는 저장하지 않는다.
	 */
	async register(input: {
		email: string;
		password: string;
		displayName: string;
		deviceName: string;
		token?: string;
		orgName?: string;
	}): Promise<void> {
		const payload: Record<string, string> = {
			email: input.email,
			password: input.password,
			display_name: input.displayName,
			device_name: input.deviceName,
		};
		if (input.token) payload.token = input.token;
		if (input.orgName) payload.org_name = input.orgName;

		const res = await this.fetcher({
			method: "POST",
			url: `${this.baseUrl}/v1/auth/signup`,
			headers: { "Content-Type": "application/json", "Accept": "application/json" },
			body: JSON.stringify(payload),
		});
		if (res.status === 409) throw new EmailAlreadyRegisteredError();
		if (res.status === 403) throw new SignupNotAllowedError();
		if (!res.ok) throw new Error(`signup failed: ${res.status}`);
		const body = await res.json<TokenResponse>();
		await this.storeTokens(body);
	}

	get authenticated(): boolean {
		return this._cachedTokens !== null && this._cachedTokens !== undefined;
	}

	async getValidAccessToken(): Promise<string> {
		const tokens = await this.loadTokens();
		if (!tokens) throw new Error("not authenticated");
		if (tokens.expiresAt - this.now() > REFRESH_THRESHOLD_MS) {
			return tokens.accessToken;
		}
		return await this.refresh(tokens.refreshToken);
	}

	/** Forces a refresh regardless of expiry. Used by API layer on 401. */
	async forceRefresh(): Promise<string> {
		const tokens = await this.loadTokens();
		if (!tokens) throw new Error("not authenticated");
		return await this.refresh(tokens.refreshToken);
	}

	async logout(): Promise<void> {
		await this.storage.clear();
		this._cachedTokens = null;
	}

	private async loadTokens(): Promise<TokenSet | null> {
		if (this._cachedTokens === undefined) {
			this._cachedTokens = await this.storage.load();
		}
		return this._cachedTokens;
	}

	private async storeTokens(resp: TokenResponse): Promise<void> {
		const tokens: TokenSet = {
			accessToken: resp.access_token,
			refreshToken: resp.refresh_token,
			expiresAt: this.now() + resp.expires_in * 1000,
		};
		await this.storage.save(tokens);
		this._cachedTokens = tokens;
	}

	private async refresh(refreshToken: string): Promise<string> {
		const res = await this.fetcher({
			method: "POST",
			url: `${this.baseUrl}/v1/auth/refresh`,
			headers: { "Content-Type": "application/json", "Accept": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		});
		if (!res.ok) {
			await this.logout();
			throw new AuthRefreshFailedError(res.status);
		}
		const body = await res.json<TokenResponse>();
		await this.storeTokens(body);
		return body.access_token;
	}
}
