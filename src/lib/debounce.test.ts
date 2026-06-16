import { debounce } from "./debounce";

describe("debounce", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	test("연속 호출을 하나로 합쳐 마지막 인자로 1회 실행한다", () => {
		const fn = jest.fn();
		const d = debounce(fn, 100);

		d("a");
		d("b");
		d("c");
		expect(fn).not.toHaveBeenCalled();

		jest.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("c");
	});

	test("대기 시간이 지난 뒤 다시 호출하면 또 실행된다", () => {
		const fn = jest.fn();
		const d = debounce(fn, 100);

		d("x");
		jest.advanceTimersByTime(100);
		d("y");
		jest.advanceTimersByTime(100);

		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenNthCalledWith(1, "x");
		expect(fn).toHaveBeenNthCalledWith(2, "y");
	});
});
