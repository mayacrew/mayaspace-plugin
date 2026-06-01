/**
 * @jest-environment jsdom
 *
 * IndexedDB persistence tests using fake-indexeddb. Verifies the exact
 * behaviour our factory relies on: a Y.Doc's updates are written to an
 * IndexedDB store keyed by docName, and a fresh Y.Doc opening the same
 * docName restores those updates without involving a server.
 *
 * This is the safety net for "Obsidian quit during offline edit → reopen
 * → user's edits still there".
 */

// jest's jsdom environment masks Node's global structuredClone; fake-indexeddb
// needs it for record cloning. Polyfill before requiring fake-indexeddb.
import { deserialize, serialize } from "node:v8";
if (typeof (globalThis as { structuredClone?: unknown }).structuredClone !== "function") {
	(globalThis as { structuredClone?: (v: unknown) => unknown }).structuredClone = (v: unknown) =>
		deserialize(serialize(v));
}

import "fake-indexeddb/auto";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

// Each test uses a unique docName to keep their IDB stores independent.
let testCounter = 0;
function uniqueName(): string {
	return `mayaspace-test-${Date.now()}-${++testCounter}`;
}

// IDB writes are async. y-indexeddb batches inside a microtask + IDB
// transaction; 50ms is comfortably long for everything to settle.
const idbSettle = () => new Promise<void>((r) => setTimeout(r, 50));

describe("IndexeddbPersistence — offline persist & restore", () => {
	test("update written in session 1 is restored into a fresh Y.Doc in session 2", async () => {
		const docName = uniqueName();

		// === Session 1: user types something while offline ===
		const doc1 = new Y.Doc();
		const persist1 = new IndexeddbPersistence(docName, doc1);
		await persist1.whenSynced;

		doc1.getText("content").insert(0, "offline edit");
		await idbSettle();
		await persist1.destroy();

		// === Session 2: Obsidian restarted, fresh Y.Doc, same docName ===
		const doc2 = new Y.Doc();
		const persist2 = new IndexeddbPersistence(docName, doc2);
		await persist2.whenSynced;

		expect(doc2.getText("content").toString()).toBe("offline edit");
		await persist2.destroy();
	});

	test("multiple sequential edits accumulate across restarts", async () => {
		const docName = uniqueName();

		const doc1 = new Y.Doc();
		const persist1 = new IndexeddbPersistence(docName, doc1);
		await persist1.whenSynced;
		doc1.getText("content").insert(0, "first ");
		await idbSettle();
		await persist1.destroy();

		const doc2 = new Y.Doc();
		const persist2 = new IndexeddbPersistence(docName, doc2);
		await persist2.whenSynced;
		expect(doc2.getText("content").toString()).toBe("first ");

		// Continue editing in session 2.
		doc2.getText("content").insert(6, "second ");
		await idbSettle();
		await persist2.destroy();

		const doc3 = new Y.Doc();
		const persist3 = new IndexeddbPersistence(docName, doc3);
		await persist3.whenSynced;
		expect(doc3.getText("content").toString()).toBe("first second ");
		await persist3.destroy();
	});

	test("different docNames use isolated stores", async () => {
		const nameA = uniqueName();
		const nameB = uniqueName();

		const docA = new Y.Doc();
		const pA = new IndexeddbPersistence(nameA, docA);
		await pA.whenSynced;
		docA.getText("content").insert(0, "A");

		const docB = new Y.Doc();
		const pB = new IndexeddbPersistence(nameB, docB);
		await pB.whenSynced;
		docB.getText("content").insert(0, "B");

		await idbSettle();
		await pA.destroy();
		await pB.destroy();

		// Cross-check: open nameA → must NOT see B's content, and vice versa.
		const restoreA = new Y.Doc();
		const rA = new IndexeddbPersistence(nameA, restoreA);
		await rA.whenSynced;
		expect(restoreA.getText("content").toString()).toBe("A");
		await rA.destroy();

		const restoreB = new Y.Doc();
		const rB = new IndexeddbPersistence(nameB, restoreB);
		await rB.whenSynced;
		expect(restoreB.getText("content").toString()).toBe("B");
		await rB.destroy();
	});

	test("end-to-end with server merge: offline edit + restart + remote update", async () => {
		// This is the full Obsidian story expressed at the Y-layer:
		//
		//   1. User opens file → IndexeddbPersistence on docName.
		//   2. User edits offline → persisted to IDB.
		//   3. Obsidian quits.
		//   4. Meanwhile a server (or other peer) has its own changes.
		//   5. User restarts → fresh Y.Doc restores from IDB → Hocuspocus
		//      sync merges with remote → both edits survive.
		const docName = uniqueName();

		// Step 1+2: offline session
		const offlineDoc = new Y.Doc();
		const offlinePersist = new IndexeddbPersistence(docName, offlineDoc);
		await offlinePersist.whenSynced;
		offlineDoc.getText("content").insert(0, "user-offline");
		await idbSettle();
		await offlinePersist.destroy();

		// Step 4: somewhere else, a server Y.Doc evolved independently
		const serverDoc = new Y.Doc();
		serverDoc.getText("content").insert(0, "server-side");
		const serverUpdate = Y.encodeStateAsUpdate(serverDoc);

		// Step 5: user restart → IDB restore → then Hocuspocus would
		// deliver serverUpdate; we apply it manually here.
		const restored = new Y.Doc();
		const restoredPersist = new IndexeddbPersistence(docName, restored);
		await restoredPersist.whenSynced;
		expect(restored.getText("content").toString()).toBe("user-offline");

		Y.applyUpdate(restored, serverUpdate);

		const merged = restored.getText("content").toString();
		expect(merged).toContain("user-offline"); // offline edit preserved
		expect(merged).toContain("server-side");  // server edit merged in

		await restoredPersist.destroy();
	});
});
