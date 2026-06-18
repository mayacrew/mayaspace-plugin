/**
 * 벌크 파일 작업용 바운디드 큐(업로드·hydrate 공용). 경로 문자열을 키로 받아 동시성을
 * 제한하며 워커(upload)를 돌린다. 워커가 무엇을 하는지는 주입에 달렸다 — 로컬→서버 업로드
 * 또는 서버→로컬 hydrate.
 *
 * 폴더를 통째로 드래그앤드랍하면 파일이 100개가 넘을 수 있다. 이를 한 번에 동시
 * 발사하면 서버 DB 커넥션 풀이 고갈되고(요청 hang), 플러그인 쪽도 파일당 WS 세션이
 * 폭주한다. 그래서 "동시에 떠 있는 업로드 ≤ concurrency"를 보장하는 큐로 흘려보낸다.
 *
 * - 동시성 상한(concurrency): 풀 크기보다 작게 잡아 다른 요청(/me 등)이 굶지 않게.
 * - 백오프 재시도: 일시적 실패(429/5xx/네트워크)는 버리지 않고 다시 시도 → 누락 방지.
 * - dedupe: 같은 경로가 큐/진행 중에 있으면 무시(개별 create 이벤트와 겹쳐도 멱등).
 *
 * 순수 모듈 — Obsidian 의존성 없음. 실제 업로드·에러 분류·sleep은 주입받는다.
 */

export interface UploadSummary {
	/** 재시도 끝에 처리(성공 또는 영구 스킵)된 건수. */
	processed: number;
	/** 일시적 재시도를 다 소진하고 포기한 건수. */
	failed: number;
}

export interface UploadQueueOptions {
	/** 동시에 진행할 최대 업로드 수. */
	concurrency: number;
	/** 한 경로당 최대 시도 횟수(1-based). */
	maxAttempts: number;
	/** attempt(1-based)별 재시도 전 대기(ms). */
	backoffMs: (attempt: number) => number;
	/** 실제 업로드. 성공=resolve, 실패=throw. */
	upload: (path: string) => Promise<void>;
	/** throw된 에러가 재시도 대상(일시적)인지. */
	isTransient: (err: unknown) => boolean;
	sleep: (ms: number) => Promise<void>;
	/** 한 건이 끝날 때마다(done, total). total은 enqueue로 늘어날 수 있다. */
	onProgress?: (done: number, total: number) => void;
	/** 큐가 비워질 때 한 번. */
	onSettled?: (summary: UploadSummary) => void;
	/** 진단 로그(선택). enqueue/start/retry/batch-settle 시 호출. 동시성·burst 관찰용. */
	log?: (message: string) => void;
}

export class UploadQueue {
	private readonly pending: string[] = [];
	private readonly known = new Set<string>();
	private active = 0;
	private total = 0;
	private done = 0;
	private failed = 0;

	constructor(private readonly opts: UploadQueueOptions) {}

	enqueue(path: string): void {
		if (this.known.has(path)) return;
		this.known.add(path);
		this.pending.push(path);
		this.total++;
		this.opts.log?.(`enqueue ${path} → pending=${this.pending.length} active=${this.active} total=${this.total}`);
		this.pump();
	}

	enqueueAll(paths: string[]): void {
		for (const path of paths) this.enqueue(path);
	}

	private pump(): void {
		while (this.active < this.opts.concurrency && this.pending.length > 0) {
			const path = this.pending.shift()!;
			this.active++;
			void this.runOne(path);
		}
	}

	private async runOne(path: string): Promise<void> {
		this.opts.log?.(`start ${path} → active=${this.active}`);
		let ok = false;
		for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
			try {
				await this.opts.upload(path);
				ok = true;
				break;
			} catch (e) {
				const canRetry = this.opts.isTransient(e) && attempt < this.opts.maxAttempts;
				if (!canRetry) break;
				const wait = this.opts.backoffMs(attempt);
				this.opts.log?.(`retry ${path} attempt=${attempt} wait=${wait}ms`);
				await this.opts.sleep(wait);
			}
		}
		this.settle(ok);
	}

	private settle(ok: boolean): void {
		this.active--;
		this.done++;
		if (!ok) this.failed++;
		this.opts.onProgress?.(this.done, this.total);

		if (this.active === 0 && this.pending.length === 0) {
			const summary: UploadSummary = { processed: this.done - this.failed, failed: this.failed };
			this.opts.log?.(`batch settled: processed=${summary.processed} failed=${summary.failed}`);
			this.reset();
			this.opts.onSettled?.(summary);
			return;
		}
		this.pump();
	}

	private reset(): void {
		this.known.clear();
		this.total = 0;
		this.done = 0;
		this.failed = 0;
	}
}
