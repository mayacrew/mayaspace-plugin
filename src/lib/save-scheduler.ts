/**
 * 잦은 저장 요청을 1회로 합치는(trailing debounce) 스케줄러 + 즉시 flush.
 *
 * 폴더 단위 대량 삭제처럼 매핑이 짧은 시간에 수백~수천 번 바뀔 때, 매 변경마다
 * saveSettings(전체 fileMappings 직렬화 + 디스크 쓰기)를 호출하면 메인 스레드가
 * O(N²)로 막힌다. 변경은 메모리에 즉시 반영하고, 디스크 쓰기만 한 번으로 묶는다.
 *
 * flush()는 언로드 시 대기 중인 저장을 잃지 않도록 즉시 비운다.
 *
 * 순수 모듈 — 타이머는 주입(테스트는 가짜 타이머로 발화 시점을 통제).
 */

export interface SaveSchedulerTimer {
	set(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
	clear(handle: ReturnType<typeof setTimeout>): void;
}

export interface SaveScheduler {
	/** 저장을 요청한다. 대기 창 안의 연속 호출은 1회로 합쳐진다. */
	schedule(): void;
	/** 대기 중인 저장이 있으면 즉시 실행하고 기다린다(언로드 flush용). */
	flush(): Promise<void>;
}

const defaultTimer: SaveSchedulerTimer = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle),
};

export function createSaveScheduler(
	save: () => Promise<void>,
	waitMs: number,
	timer: SaveSchedulerTimer = defaultTimer,
): SaveScheduler {
	let handle: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;

	const fire = (): void => {
		handle = null;
		if (!dirty) return;
		dirty = false;
		void save().catch(() => undefined);
	};

	return {
		schedule(): void {
			dirty = true;
			if (handle) timer.clear(handle);
			handle = timer.set(fire, waitMs);
		},
		async flush(): Promise<void> {
			if (handle) {
				timer.clear(handle);
				handle = null;
			}
			if (!dirty) return;
			dirty = false;
			await save().catch(() => undefined);
		},
	};
}
