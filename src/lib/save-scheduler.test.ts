import { createSaveScheduler, type SaveSchedulerTimer } from "./save-scheduler";

/** 발화 시점을 테스트가 통제할 수 있는 가짜 타이머. */
function fakeTimer() {
	let pending: (() => void) | null = null;
	const timer: SaveSchedulerTimer = {
		set: (fn) => {
			pending = fn;
			return 1 as unknown as ReturnType<typeof setTimeout>;
		},
		clear: () => {
			pending = null;
		},
	};
	return {
		timer,
		fire: () => {
			const fn = pending;
			pending = null;
			fn?.();
		},
		hasPending: () => pending !== null,
	};
}

describe("createSaveScheduler", () => {
	test("대기 창 안의 연속 schedule을 1회 저장으로 합친다", () => {
		const { timer, fire } = fakeTimer();
		let saves = 0;
		const s = createSaveScheduler(async () => { saves++; }, 500, timer);

		s.schedule();
		s.schedule();
		s.schedule();
		expect(saves).toBe(0); // 타이머 발화 전엔 저장 안 함

		fire();
		expect(saves).toBe(1); // 여러 번 호출해도 한 번만
	});

	test("flush는 대기 중 저장을 즉시 실행하고 타이머를 취소한다", async () => {
		const { timer, fire, hasPending } = fakeTimer();
		let saves = 0;
		const s = createSaveScheduler(async () => { saves++; }, 500, timer);

		s.schedule();
		await s.flush();
		expect(saves).toBe(1);
		expect(hasPending()).toBe(false);

		fire(); // 이미 취소됐으니 중복 저장 없음
		expect(saves).toBe(1);
	});

	test("대기 중 저장이 없으면 flush는 저장하지 않는다", async () => {
		const { timer } = fakeTimer();
		let saves = 0;
		const s = createSaveScheduler(async () => { saves++; }, 500, timer);

		await s.flush();
		expect(saves).toBe(0);
	});

	test("저장이 발화한 뒤 새 schedule은 다시 저장한다", () => {
		const { timer, fire } = fakeTimer();
		let saves = 0;
		const s = createSaveScheduler(async () => { saves++; }, 500, timer);

		s.schedule();
		fire();
		expect(saves).toBe(1);

		s.schedule();
		fire();
		expect(saves).toBe(2);
	});
});
