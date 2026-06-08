/**
 * 줄 단위 diff (순수 함수). 외부 의존 없이 LCS로 공통 줄을 찾고,
 * 나머지를 삭제(del)/추가(add)로 표시한다. 변경된 줄은 del + add로 나온다.
 *
 * 렌더링(색칠 등)은 호출하는 UI가 한다 — 이 함수는 데이터만 반환한다.
 */

export type DiffLine = { type: "add" | "del" | "same"; text: string };

export function diffLines(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const lcs = buildLcsTable(oldLines, newLines);
	return walkBackwards(oldLines, newLines, lcs);
}

/** lcs[i][j] = oldLines[i:]와 newLines[j:]의 최장 공통 부분수열 길이. */
function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
	const m = oldLines.length;
	const n = newLines.length;
	const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (oldLines[i] === newLines[j]) {
				lcs[i][j] = lcs[i + 1][j + 1] + 1;
			} else {
				lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
			}
		}
	}
	return lcs;
}

function walkBackwards(oldLines: string[], newLines: string[], lcs: number[][]): DiffLine[] {
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;

	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			result.push({ type: "same", text: oldLines[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			result.push({ type: "del", text: oldLines[i] });
			i++;
		} else {
			result.push({ type: "add", text: newLines[j] });
			j++;
		}
	}

	while (i < oldLines.length) result.push({ type: "del", text: oldLines[i++] });
	while (j < newLines.length) result.push({ type: "add", text: newLines[j++] });

	return result;
}
