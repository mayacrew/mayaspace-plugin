import {
  MayaspaceAuth, InMemoryTokenStorage, DeviceFlowPendingError, DeviceFlowExpiredError,
  EmailAlreadyRegisteredError, SignupNotAllowedError,
} from "./mayaspace-auth";
import type { Fetcher, HttpRequest, HttpResponse } from "../api/mayaspace-http";

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): HttpResponse {
	return {
		status,
		ok: status >= 200 && status < 300,
		text: async () => JSON.stringify(body),
		json: async <T>() => body as T,
		arrayBuffer: async () => new ArrayBuffer(0),
		headers: { "content-type": "application/json", ...extraHeaders },
	};
}

function makeFetcher(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>): Fetcher {
	return async (req) => handler(req);
}

describe("MayaspaceAuth.startDeviceFlow", () => {
	test("POST /v1/auth/device/init body에 device_name 포함 + 응답 매핑", async () => {
		const calls: HttpRequest[] = [];
		const fetcher = makeFetcher((req) => {
			calls.push(req);
			return jsonResponse(200, {
				device_code: "DEV-1",
				user_code: "ABCD-1234",
				verification_uri: "https://example.com/device",
				interval: 5,
				expires_in: 600,
			});
		});

		const auth = new MayaspaceAuth("https://api.test", fetcher, new InMemoryTokenStorage());
		const session = await auth.startDeviceFlow("Obsidian on Alice's Mac");

		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toBe("https://api.test/v1/auth/device/init");
		expect(calls[0].body).toBe(JSON.stringify({ device_name: "Obsidian on Alice's Mac" }));
		expect(session.deviceCode).toBe("DEV-1");
		expect(session.userCode).toBe("ABCD-1234");
		expect(session.verificationUri).toBe("https://example.com/device");
		expect(session.intervalSec).toBe(5);
	});
});

describe("MayaspaceAuth.pollDeviceFlow", () => {
	test("승인 시 token 저장 + access token 반환", async () => {
		const storage = new InMemoryTokenStorage();
		const fetcher = makeFetcher(() => jsonResponse(200, {
			access_token: "AT-1",
			refresh_token: "RT-1",
			expires_in: 3600,
		}));

		const auth = new MayaspaceAuth("https://api.test", fetcher, storage);
		await auth.pollDeviceFlow("DEV-1");

		const tokens = await storage.load();
		expect(tokens?.accessToken).toBe("AT-1");
		expect(tokens?.refreshToken).toBe("RT-1");
		expect(auth.authenticated).toBe(true);
	});

	test("428 Pending → DeviceFlowPendingError 던짐", async () => {
		const fetcher = makeFetcher(() => jsonResponse(428, { error: "pending" }));
		const auth = new MayaspaceAuth("https://api.test", fetcher, new InMemoryTokenStorage());

		await expect(auth.pollDeviceFlow("DEV-1")).rejects.toBeInstanceOf(DeviceFlowPendingError);
	});

	test("410 Expired → DeviceFlowExpiredError 던짐", async () => {
		const fetcher = makeFetcher(() => jsonResponse(410, { error: "expired" }));
		const auth = new MayaspaceAuth("https://api.test", fetcher, new InMemoryTokenStorage());

		await expect(auth.pollDeviceFlow("DEV-1")).rejects.toBeInstanceOf(DeviceFlowExpiredError);
	});
});

describe("MayaspaceAuth.getValidAccessToken", () => {
	test("저장된 token이 유효하면 그대로 반환", async () => {
		const storage = new InMemoryTokenStorage();
		await storage.save({ accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 60000 });
		const fetcher = makeFetcher(() => { throw new Error("must not be called"); });

		const auth = new MayaspaceAuth("https://api.test", fetcher, storage);
		expect(await auth.getValidAccessToken()).toBe("AT");
	});

	test("만료 임박 시 refresh 호출 + 새 token 저장", async () => {
		const storage = new InMemoryTokenStorage();
		await storage.save({ accessToken: "AT-OLD", refreshToken: "RT-OLD", expiresAt: Date.now() + 1000 });
		const calls: HttpRequest[] = [];
		const fetcher = makeFetcher((req) => {
			calls.push(req);
			return jsonResponse(200, { access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 });
		});

		const auth = new MayaspaceAuth("https://api.test", fetcher, storage);
		const tok = await auth.getValidAccessToken();

		expect(tok).toBe("AT-NEW");
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.test/v1/auth/refresh");
		expect(calls[0].method).toBe("POST");
		const tokens = await storage.load();
		expect(tokens?.refreshToken).toBe("RT-NEW");
	});

	test("token 없으면 에러", async () => {
		const auth = new MayaspaceAuth("https://api.test", makeFetcher(() => jsonResponse(200, {})), new InMemoryTokenStorage());
		await expect(auth.getValidAccessToken()).rejects.toThrow(/not authenticated/i);
	});
});

describe("MayaspaceAuth.logout", () => {
	test("저장소 비우고 authenticated false", async () => {
		const storage = new InMemoryTokenStorage();
		await storage.save({ accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 60000 });

		const auth = new MayaspaceAuth("https://api.test", makeFetcher(() => jsonResponse(204, {})), storage);
		await auth.logout();

		expect(await storage.load()).toBeNull();
		expect(auth.authenticated).toBe(false);
	});
});

describe("MayaspaceAuth.register", () => {
  test("POST /v1/auth/signup 호출 + 성공 시 토큰 저장", async () => {
    const storage = new InMemoryTokenStorage();
    const calls: HttpRequest[] = [];
    const fetcher = makeFetcher((req) => {
      calls.push(req);
      return jsonResponse(200, { access_token: "AT-S", refresh_token: "RT-S", expires_in: 3600 });
    });

    const auth = new MayaspaceAuth("https://api.test", fetcher, storage);
    await auth.register({
      email: "new@x.com", password: "pw12345678", displayName: "New",
      deviceName: "Obsidian (Mac)", orgName: "Acme",
    });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.test/v1/auth/signup");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      email: "new@x.com", password: "pw12345678", display_name: "New",
      device_name: "Obsidian (Mac)", org_name: "Acme",
    });
    const tokens = await storage.load();
    expect(tokens?.accessToken).toBe("AT-S");
    expect(auth.authenticated).toBe(true);
  });

  test("token 모드는 token만 보낸다", async () => {
    const calls: HttpRequest[] = [];
    const fetcher = makeFetcher((req) => {
      calls.push(req);
      return jsonResponse(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    });
    const auth = new MayaspaceAuth("https://api.test", fetcher, new InMemoryTokenStorage());
    await auth.register({ email: "a@x", password: "pw12345678", displayName: "A", deviceName: "Obsidian", token: "INV-1" });
    expect(JSON.parse(calls[0].body as string)).toEqual({
      email: "a@x", password: "pw12345678", display_name: "A", device_name: "Obsidian", token: "INV-1",
    });
  });

  test("409 → EmailAlreadyRegisteredError", async () => {
    const fetcher = makeFetcher(() => jsonResponse(409, { detail: "Email already registered" }));
    const auth = new MayaspaceAuth("https://api.test", fetcher, new InMemoryTokenStorage());
    await expect(auth.register({ email: "a@x", password: "pw12345678", displayName: "A", deviceName: "Obsidian", orgName: "A" }))
      .rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
  });

  test("403 → SignupNotAllowedError", async () => {
    const fetcher = makeFetcher(() => jsonResponse(403, { detail: "Signup is invite-only" }));
    const auth = new MayaspaceAuth("https://api.test", fetcher, new InMemoryTokenStorage());
    await expect(auth.register({ email: "a@x", password: "pw12345678", displayName: "A", deviceName: "Obsidian", orgName: "A" }))
      .rejects.toBeInstanceOf(SignupNotAllowedError);
  });
});
