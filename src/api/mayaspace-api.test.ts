import { MayaspaceApi } from "./mayaspace-api";
import { MayaspaceAuth, InMemoryTokenStorage } from "../auth/mayaspace-auth";
import type { Fetcher, HttpRequest, HttpResponse } from "./mayaspace-http";

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): HttpResponse {
	return {
		status,
		ok: status >= 200 && status < 300,
		text: async () => JSON.stringify(body),
		json: async <T>() => body as T,
		headers: { "content-type": "application/json", ...extraHeaders },
	};
}

function textResponse(status: number, body: string, extraHeaders: Record<string, string> = {}): HttpResponse {
	return {
		status,
		ok: status >= 200 && status < 300,
		text: async () => body,
		json: async <T>() => body as unknown as T,
		headers: { "content-type": "text/markdown", ...extraHeaders },
	};
}

async function authedAuth(): Promise<{ auth: MayaspaceAuth; storage: InMemoryTokenStorage }> {
	const storage = new InMemoryTokenStorage();
	await storage.save({ accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 60_000 });
	const auth = new MayaspaceAuth("https://api.test", async () => jsonResponse(200, {}), storage);
	return { auth, storage };
}

describe("MayaspaceApi", () => {
	test("listOrgs: GET /v1/orgs with Bearer header", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(200, {
				organizations: [
					{ id: "o1", name: "Acme", role: "admin", created_at: "2026-01-01T00:00:00Z" },
					{ id: "o2", name: "Personal", role: "member", created_at: "2026-01-02T00:00:00Z" },
				],
			});
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const orgs = await api.listOrgs();
		expect(orgs.map((o) => o.id)).toEqual(["o1", "o2"]);
		expect(orgs[0].name).toBe("Acme");
		expect(orgs[0].role).toBe("admin");
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toBe("https://api.test/v1/orgs");
		expect(calls[0].headers.Authorization).toBe("Bearer AT");
	});

	test("createOrg: POST /v1/orgs with name", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(201, { id: "o9", name: "New Org", created_at: "2026-05-26T00:00:00Z" });
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const org = await api.createOrg("New Org");
		expect(org).toEqual({ id: "o9", name: "New Org", created_at: "2026-05-26T00:00:00Z" });
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toBe("https://api.test/v1/orgs");
		expect(calls[0].body).toContain("New Org");
	});

	test("readFile: GET /v1/orgs/:oid/files/:fid returns raw markdown + ETag header", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return textResponse(200, "# Hello\n\nbody", { etag: '"abc"' });
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const result = await api.readFile("o1", "f1");
		expect(result.content).toBe("# Hello\n\nbody");
		expect(result.etag).toBe('"abc"');
		expect(calls[0].url).toBe("https://api.test/v1/orgs/o1/files/f1");
		expect(calls[0].method).toBe("GET");
	});

	test("writeFile: PUT raw markdown with If-Match, etag from JSON body", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(200, { id: "f1", etag: "newtag", mtime: "2026-05-26T01:00:00Z" });
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const { etag } = await api.writeFile("o1", "f1", "new content", '"abc"');
		expect(etag).toBe("newtag");
		expect(calls[0].method).toBe("PUT");
		expect(calls[0].url).toBe("https://api.test/v1/orgs/o1/files/f1");
		expect(calls[0].headers["If-Match"]).toBe('"abc"');
		expect(calls[0].headers["Content-Type"]).toBe("text/markdown");
		expect(calls[0].body).toBe("new content");
	});

	test("401 응답 시 refresh 시도 후 재시도", async () => {
		const storage = new InMemoryTokenStorage();
		await storage.save({ accessToken: "AT-OLD", refreshToken: "RT", expiresAt: Date.now() + 60_000 });
		const authFetchCalls: HttpRequest[] = [];
		const authFetcher: Fetcher = async (req) => {
			authFetchCalls.push(req);
			return jsonResponse(200, { access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 });
		};
		const auth = new MayaspaceAuth("https://api.test", authFetcher, storage);

		const apiCalls: HttpRequest[] = [];
		let attempt = 0;
		const apiFetcher: Fetcher = async (req) => {
			apiCalls.push(req);
			attempt += 1;
			if (attempt === 1) return jsonResponse(401, { error: "unauthorized" });
			return jsonResponse(200, { organizations: [] });
		};
		const api = new MayaspaceApi("https://api.test", auth, apiFetcher);

		await api.listOrgs();
		expect(apiCalls).toHaveLength(2);
		expect(apiCalls[0].headers.Authorization).toBe("Bearer AT-OLD");
		expect(apiCalls[1].headers.Authorization).toBe("Bearer AT-NEW");
		expect(authFetchCalls).toHaveLength(1);
	});

	test("412 Precondition Failed → 명확한 에러 throw", async () => {
		const { auth } = await authedAuth();
		const fetcher: Fetcher = async () => jsonResponse(412, { error: "etag_mismatch" });
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		await expect(api.writeFile("o1", "f1", "x", '"old"')).rejects.toThrow(/etag/i);
	});

	test("getTree: GET /v1/orgs/:oid/files/tree", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(200, {
				files: [
					{ id: "f1", path: "README.md", size: 10, etag: "e1", mtime: "2026-05-26T00:00:00Z" },
					{ id: "f2", path: "Welcome.md", size: 20, etag: "e2", mtime: "2026-05-26T00:00:00Z" },
				],
			});
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const files = await api.getTree("o1");
		expect(files.map((f) => f.path)).toEqual(["README.md", "Welcome.md"]);
		expect(calls[0].url).toBe("https://api.test/v1/orgs/o1/files/tree");
	});

	test("createFile: POST /v1/orgs/:oid/files with path", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(201, { id: "f1", path: "new.md", etag: "e1", mtime: "2026-05-26T00:00:00Z", size: 0 });
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const meta = await api.createFile("o1", "new.md");
		expect(meta.id).toBe("f1");
		expect(meta.path).toBe("new.md");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toBe("https://api.test/v1/orgs/o1/files");
		expect(calls[0].body).toContain("new.md");
	});

	test("deleteFile: DELETE /v1/orgs/:oid/files/:fid", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(204, {});
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		await api.deleteFile("o1", "f1");
		expect(calls[0].method).toBe("DELETE");
		expect(calls[0].url).toBe("https://api.test/v1/orgs/o1/files/f1");
	});

	test("moveFile: POST /v1/orgs/:oid/files/:fid/move with new_path", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(200, { id: "f1", path: "archive/note.md", etag: "e2" });
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		await api.moveFile("o1", "f1", "archive/note.md");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toBe("https://api.test/v1/orgs/o1/files/f1/move");
		expect(calls[0].body).toContain("new_path");
		expect(calls[0].body).toContain("archive/note.md");
	});

	test("me(): GET /v1/auth/me", async () => {
		const { auth } = await authedAuth();
		const fetcher: Fetcher = async () => jsonResponse(200, { id: "u1", email: "alice@example.com", deviceId: "d1" });
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const me = await api.me();
		expect(me.email).toBe("alice@example.com");
	});

	test("capabilities(): GET /v1/capabilities", async () => {
		const { auth } = await authedAuth();
		const calls: HttpRequest[] = [];
		const fetcher: Fetcher = async (req) => {
			calls.push(req);
			return jsonResponse(200, { features: { hocuspocus: true } });
		};
		const api = new MayaspaceApi("https://api.test", auth, fetcher);

		const caps = await api.capabilities();
		expect((caps as any).features.hocuspocus).toBe(true);
		expect(calls[0].url).toBe("https://api.test/v1/capabilities");
	});
});
