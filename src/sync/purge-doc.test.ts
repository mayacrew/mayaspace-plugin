/**
 * @jest-environment jsdom
 *
 * MayaspaceSync.purgeDoc deletes the on-disk IndexedDB snapshot for a doc, not
 * just the in-memory provider (#9). Without this, document content survives
 * logout / READ revocation / delete locally. Uses fake-indexeddb to assert the
 * persisted store is actually gone.
 */

// jsdom masks Node's structuredClone; fake-indexeddb needs it. Polyfill first.
import { deserialize, serialize } from "node:v8";
if (typeof (globalThis as { structuredClone?: unknown }).structuredClone !== "function") {
	(globalThis as { structuredClone?: (v: unknown) => unknown }).structuredClone = (v: unknown) =>
		deserialize(serialize(v));
}

import "fake-indexeddb/auto";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

import { MayaspaceSync, type ProviderFactory } from "./mayaspace-sync";
import { MayaspaceAuth, InMemoryTokenStorage } from "../auth/mayaspace-auth";

const idbSettle = () => new Promise<void>((r) => setTimeout(r, 50));

async function authedAuth(): Promise<MayaspaceAuth> {
	const storage = new InMemoryTokenStorage();
	await storage.save({ accessToken: "AT-1", refreshToken: "RT-1", expiresAt: Date.now() + 60_000 });
	return new MayaspaceAuth("https://api.test", async () => ({
		status: 200, ok: true,
		text: async () => "{}", json: async <T>() => ({} as T),
		headers: {},
	}), storage);
}

function mockFactory(): ProviderFactory {
	return () => {
		const doc = new Y.Doc();
		return { doc, awareness: { destroy: jest.fn() } as any, destroy: jest.fn(), whenSynced: Promise.resolve() };
	};
}

async function seedSnapshot(docName: string, text: string): Promise<void> {
	const doc = new Y.Doc();
	const persist = new IndexeddbPersistence(docName, doc);
	await persist.whenSynced;
	doc.getText("content").insert(0, text);
	await idbSettle();
	await persist.destroy();
}

async function readSnapshot(docName: string): Promise<string> {
	const doc = new Y.Doc();
	const persist = new IndexeddbPersistence(docName, doc);
	await persist.whenSynced;
	const out = doc.getText("content").toString();
	await persist.destroy();
	return out;
}

describe("MayaspaceSync.purgeDoc", () => {
	test("persisted IndexedDB snapshot is deleted", async () => {
		const docName = "org:o:file:f";
		await seedSnapshot(docName, "secret content");
		expect(await readSnapshot(docName)).toBe("secret content");

		const sync = new MayaspaceSync("ws://localhost:3001", await authedAuth(), mockFactory());
		await sync.purgeDoc("o", "f");
		await idbSettle();

		// A fresh persistence under the same name restores nothing → store gone.
		expect(await readSnapshot(docName)).toBe("");
	});

	test("drops the live provider entry too", async () => {
		const sync = new MayaspaceSync("ws://localhost:3001", await authedAuth(), mockFactory());
		await sync.openDoc("o", "f");
		expect(sync.isOpen("o", "f")).toBe(true);

		await sync.purgeDoc("o", "f");
		expect(sync.isOpen("o", "f")).toBe(false);
	});

	test("purge with no live entry and no store is a noop", async () => {
		const sync = new MayaspaceSync("ws://localhost:3001", await authedAuth(), mockFactory());
		await expect(sync.purgeDoc("o", "missing")).resolves.toBeUndefined();
	});
});
