import { UploadQueue, type UploadQueueOptions } from "./upload-queue";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeOpts(overrides: Partial<UploadQueueOptions>): UploadQueueOptions {
	return {
		concurrency: 3,
		maxAttempts: 3,
		backoffMs: () => 0,
		isTransient: () => true,
		sleep: () => Promise.resolve(),
		upload: async () => undefined,
		...overrides,
	};
}

/** onSettled가 부를 때까지 기다린 뒤 summary를 돌려준다. */
function settle(
	build: (onSettled: UploadQueueOptions["onSettled"]) => UploadQueue,
): Promise<{ processed: number; failed: number }> {
	return new Promise((resolve) => {
		build((summary) => resolve(summary));
	});
}

describe("UploadQueue", () => {
	test("enqueue한 모든 경로를 업로드한다", async () => {
		const uploaded: string[] = [];
		const summary = await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({ upload: async (p) => { uploaded.push(p); }, onSettled }));
			q.enqueueAll(["a", "b", "c"]);
			return q;
		});
		expect(uploaded.sort()).toEqual(["a", "b", "c"]);
		expect(summary).toEqual({ processed: 3, failed: 0 });
	});

	test("같은 경로 중복 enqueue는 한 번만 업로드(dedupe)", async () => {
		const uploaded: string[] = [];
		const summary = await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({ upload: async (p) => { uploaded.push(p); }, onSettled }));
			q.enqueue("a");
			q.enqueue("a");
			q.enqueue("b");
			return q;
		});
		expect(uploaded.sort()).toEqual(["a", "b"]);
		expect(summary.processed).toBe(2);
	});

	test("동시 실행이 concurrency를 넘지 않는다", async () => {
		let current = 0;
		let max = 0;
		await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({
				concurrency: 2,
				upload: async () => { current++; max = Math.max(max, current); await tick(); current--; },
				onSettled,
			}));
			q.enqueueAll(["a", "b", "c", "d", "e"]);
			return q;
		});
		expect(max).toBe(2);
	});

	test("일시적 실패는 백오프 후 재시도해 결국 성공", async () => {
		let attempts = 0;
		const summary = await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({
				maxAttempts: 3,
				isTransient: () => true,
				upload: async () => { attempts++; if (attempts < 3) throw new Error("temporary"); },
				onSettled,
			}));
			q.enqueue("a");
			return q;
		});
		expect(attempts).toBe(3);
		expect(summary).toEqual({ processed: 1, failed: 0 });
	});

	test("maxAttempts까지 실패하면 포기하고 failed로 집계", async () => {
		let attempts = 0;
		const summary = await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({
				maxAttempts: 3,
				isTransient: () => true,
				upload: async () => { attempts++; throw new Error("always"); },
				onSettled,
			}));
			q.enqueue("a");
			return q;
		});
		expect(attempts).toBe(3);
		expect(summary).toEqual({ processed: 0, failed: 1 });
	});

	test("일시적이지 않은 에러는 재시도하지 않는다", async () => {
		let attempts = 0;
		const summary = await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({
				maxAttempts: 3,
				isTransient: () => false,
				upload: async () => { attempts++; throw new Error("permanent"); },
				onSettled,
			}));
			q.enqueue("a");
			return q;
		});
		expect(attempts).toBe(1);
		expect(summary).toEqual({ processed: 0, failed: 1 });
	});

	test("재시도 사이에 backoffMs만큼 sleep한다", async () => {
		const slept: number[] = [];
		let attempts = 0;
		await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({
				maxAttempts: 3,
				backoffMs: (attempt) => attempt * 100,
				sleep: async (ms) => { slept.push(ms); },
				upload: async () => { attempts++; if (attempts < 3) throw new Error("temporary"); },
				onSettled,
			}));
			q.enqueue("a");
			return q;
		});
		expect(slept).toEqual([100, 200]);
	});

	test("log 훅이 enqueue와 batch settled에서 호출된다", async () => {
		const logs: string[] = [];
		await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({ log: (m) => logs.push(m), onSettled }));
			q.enqueueAll(["a", "b"]);
			return q;
		});
		expect(logs.some((m) => m.startsWith("enqueue a"))).toBe(true);
		expect(logs.some((m) => m.startsWith("batch settled"))).toBe(true);
	});

	test("onProgress가 done/total을 보고한다", async () => {
		const progress: Array<[number, number]> = [];
		await settle((onSettled) => {
			const q = new UploadQueue(makeOpts({
				onProgress: (done, total) => progress.push([done, total]),
				onSettled,
			}));
			q.enqueueAll(["a", "b"]);
			return q;
		});
		expect(progress[progress.length - 1]).toEqual([2, 2]);
	});
});
