/**
 * Transport-agnostic HTTP layer for MayaSpace REST.
 *
 * Obsidian's requestUrl bypasses CORS at runtime, while fetchAdapter is used
 * by jest tests (Node environment).
 */

export interface HttpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface HttpResponse {
	status: number;
	ok: boolean;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	headers: Record<string, string>;
}

export type Fetcher = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchAdapter: Fetcher = async (req) => {
	const res = await fetch(req.url, {
		method: req.method,
		headers: req.headers,
		body: req.body,
		signal: req.signal,
	});
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
	return {
		status: res.status,
		ok: res.ok,
		text: () => res.text(),
		json: <T>() => res.json() as Promise<T>,
		headers,
	};
};

/**
 * Adapter for Obsidian's requestUrl. Constructed inside the plugin so tests
 * never import obsidian.
 */
export function makeObsidianFetcher(requestUrl: (opts: {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	throw?: boolean;
}) => Promise<{ status: number; text: string; json: any; headers: Record<string, string> }>): Fetcher {
	return async (req) => {
		const res = await requestUrl({
			url: req.url,
			method: req.method,
			headers: req.headers,
			body: req.body,
			throw: false,
		});
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(res.headers ?? {})) {
			headers[k.toLowerCase()] = String(v);
		}
		return {
			status: res.status,
			ok: res.status >= 200 && res.status < 300,
			text: async () => res.text,
			json: async <T>() => res.json as T,
			headers,
		};
	};
}

export class HttpError extends Error {
	constructor(public status: number, message: string, public body?: string) {
		super(message);
	}
}
