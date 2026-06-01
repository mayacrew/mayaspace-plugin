/**
 * MayaSpace REST client.
 *
 * - Bearer auth via MayaspaceAuth.getValidAccessToken() (handles refresh)
 * - One automatic retry on 401 (token expired between cache check and request)
 * - 412 Precondition Failed → EtagMismatchError so callers can surface conflicts
 *
 * Paths follow the server's org-centric convention (/v1/orgs/...).
 * File body is sent/received as raw text/markdown; metadata as JSON.
 */

import type { MayaspaceAuth } from "../auth/mayaspace-auth";
import type { Fetcher, HttpRequest, HttpResponse } from "./mayaspace-http";

export interface Org {
	id: string;
	name: string;
	role?: "admin" | "member";
	created_at?: string;
	/** R|U|C|D bits at root path. Server computes from base bits + ACL rules. */
	effective_permissions?: number;
}
export interface OrgMember { user_id: string; role: string; }
export interface FileMeta { id: string; path: string; etag?: string; mtime?: string; size?: number; }
export interface UserInfo { id: string; email: string; deviceId?: string; }

export class EtagMismatchError extends Error {
	constructor(public serverEtag?: string) { super("etag mismatch"); }
}

export class MayaspaceApi {
	constructor(
		private baseUrl: string,
		private auth: MayaspaceAuth,
		private fetcher: Fetcher,
	) {}

	// ---- Auth ----
	me(): Promise<UserInfo> {
		return this.request<UserInfo>("GET", "/v1/auth/me");
	}

	// ---- Organizations ----
	async listOrgs(): Promise<Org[]> {
		const body = await this.request<{ organizations: Org[] }>("GET", "/v1/orgs");
		return body.organizations;
	}
	createOrg(name: string): Promise<Org> {
		return this.request<Org>("POST", "/v1/orgs", { body: { name } });
	}
	async listOrgMembers(orgId: string): Promise<OrgMember[]> {
		const body = await this.request<{ members: OrgMember[] }>("GET", `/v1/orgs/${enc(orgId)}/members`);
		return body.members;
	}

	// ---- Files ----
	async getTree(orgId: string): Promise<FileMeta[]> {
		const body = await this.request<{ files: FileMeta[] }>("GET", `/v1/orgs/${enc(orgId)}/files/tree`);
		return body.files;
	}
	createFile(orgId: string, path: string, contentBase64?: string): Promise<FileMeta> {
		const body = contentBase64 ? { path, content_base64: contentBase64 } : { path };
		return this.request<FileMeta>("POST", `/v1/orgs/${enc(orgId)}/files`, { body });
	}
	async readFile(orgId: string, fileId: string): Promise<{ content: string; etag: string }> {
		const { res, body } = await this.rawRequest("GET", `/v1/orgs/${enc(orgId)}/files/${enc(fileId)}`, {
			extraHeaders: { Accept: "text/markdown" },
			rawResponse: true,
		});
		return { content: body as string, etag: res.headers["etag"] ?? "" };
	}
	async writeFile(orgId: string, fileId: string, content: string, etag: string): Promise<{ etag: string }> {
		const { body } = await this.rawRequest("PUT", `/v1/orgs/${enc(orgId)}/files/${enc(fileId)}`, {
			rawBody: content,
			extraHeaders: { "If-Match": etag, "Content-Type": "text/markdown" },
		});
		const parsed = body as { etag?: string } | null;
		return { etag: parsed?.etag ?? "" };
	}
	async deleteFile(orgId: string, fileId: string): Promise<void> {
		await this.request<void>("DELETE", `/v1/orgs/${enc(orgId)}/files/${enc(fileId)}`);
	}
	async moveFile(orgId: string, fileId: string, newPath: string): Promise<void> {
		await this.request<void>("POST", `/v1/orgs/${enc(orgId)}/files/${enc(fileId)}/move`, {
			body: { new_path: newPath },
		});
	}

	// ---- Capabilities ----
	capabilities(): Promise<unknown> {
		return this.request<unknown>("GET", "/v1/capabilities");
	}

	// ---- Internals ----
	private async request<T>(method: string, path: string, opts?: { body?: unknown }): Promise<T> {
		const { body } = await this.rawRequest(method, path, opts);
		return body as T;
	}

	private async rawRequest(
		method: string,
		path: string,
		opts?: {
			body?: unknown;
			rawBody?: string;
			rawResponse?: boolean;
			extraHeaders?: Record<string, string>;
		},
	): Promise<{ res: HttpResponse; body: unknown }> {
		const hasJsonBody = opts?.body !== undefined;
		const hasRawBody = opts?.rawBody !== undefined;
		const bodyStr = hasRawBody ? opts!.rawBody : hasJsonBody ? JSON.stringify(opts!.body) : undefined;

		const send = async (token: string): Promise<HttpResponse> => {
			const req: HttpRequest = {
				method,
				url: `${this.baseUrl}${path}`,
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
					...(hasJsonBody && !hasRawBody ? { "Content-Type": "application/json" } : {}),
					...(opts?.extraHeaders ?? {}),
				},
				body: bodyStr,
			};
			return await this.fetcher(req);
		};

		let token = await this.auth.getValidAccessToken();
		let res = await send(token);

		if (res.status === 401) {
			token = await this.auth.forceRefresh();
			res = await send(token);
		}

		if (res.status === 412) {
			const serverEtag = res.headers["etag"];
			throw new EtagMismatchError(serverEtag);
		}
		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			throw new Error(`${method} ${path} failed: ${res.status} ${errText}`);
		}

		const text = await res.text();
		if (opts?.rawResponse) {
			return { res, body: text };
		}
		const body = text.length > 0 ? JSON.parse(text) : null;
		return { res, body };
	}
}

function enc(v: string): string { return encodeURIComponent(v); }
