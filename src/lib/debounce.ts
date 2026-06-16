/**
 * 연속 호출을 마지막 1회로 합친다(trailing). 대기 시간 동안 추가 호출이 오면 타이머를 리셋한다.
 * access.changed 신호가 짧게 몰아쳐도 syncTrees를 한 번만 돌리는 데 쓴다.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return (...args: A) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, waitMs);
	};
}
