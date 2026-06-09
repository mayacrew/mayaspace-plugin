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

/** 줄번호가 붙은 diff 행. del은 구 줄번호만, add는 신 줄번호만 갖는다. */
export type DiffRow = DiffLine & { oldNo: number | null; newNo: number | null };

export function diffRows(oldText: string, newText: string): DiffRow[] {
	let oldNo = 0;
	let newNo = 0;
	return diffLines(oldText, newText).map((line) => {
		if (line.type === "same") return { ...line, oldNo: ++oldNo, newNo: ++newNo };
		if (line.type === "del") return { ...line, oldNo: ++oldNo, newNo: null };
		return { ...line, oldNo: null, newNo: ++newNo };
	});
}

/** 줄 내 토큰 단위 강조용. changed=true인 토큰만 바뀐 부분이다. */
export type WordPart = { text: string; changed: boolean };

/** 공백/단어/기호를 토큰으로 보존해 재구성이 원본과 정확히 일치하게 한다. */
function tokenize(line: string): string[] {
	return line.match(/(\s+|\w+|[^\s\w]+)/gu) ?? [];
}

export function diffWords(oldLine: string, newLine: string): { a: WordPart[]; b: WordPart[] } {
	const aTok = tokenize(oldLine);
	const bTok = tokenize(newLine);
	const seq = walkBackwards(aTok, bTok, buildLcsTable(aTok, bTok));

	const a: WordPart[] = [];
	const b: WordPart[] = [];
	for (const t of seq) {
		if (t.type === "same") {
			a.push({ text: t.text, changed: false });
			b.push({ text: t.text, changed: false });
		} else if (t.type === "del") {
			a.push({ text: t.text, changed: true });
		} else {
			b.push({ text: t.text, changed: true });
		}
	}
	return { a, b };
}

/** 변경 없는 긴 구간을 접기 위한 세그먼트. collapsed.rows는 숨겨진 동일 줄들. */
export type DiffSegment =
	| { kind: "rows"; rows: DiffRow[] }
	| { kind: "collapsed"; rows: DiffRow[] };

/**
 * 연속된 same 구간이 context*2를 넘으면 가운데를 접는다. 변경 주변 context줄은 노출한다.
 * 파일 맨 앞/뒤의 same 구간은 바깥쪽 컨텍스트를 생략한다(한쪽에만 변경이 있으므로).
 */
export function collapseRows(rows: DiffRow[], context = 3): DiffSegment[] {
	const segments: DiffSegment[] = [];
	let pending: DiffRow[] = [];
	const flush = (): void => {
		if (pending.length) segments.push({ kind: "rows", rows: pending });
		pending = [];
	};

	let i = 0;
	while (i < rows.length) {
		if (rows[i].type !== "same") {
			pending.push(rows[i]);
			i++;
			continue;
		}

		let j = i;
		while (j < rows.length && rows[j].type === "same") j++;
		const run = rows.slice(i, j);

		const before = i === 0 ? 0 : context;
		const after = j === rows.length ? 0 : context;
		if (run.length <= before + after) {
			pending.push(...run);
		} else {
			if (before) pending.push(...run.slice(0, before));
			flush();
			segments.push({ kind: "collapsed", rows: run.slice(before, run.length - after) });
			pending = after ? run.slice(run.length - after) : [];
		}
		i = j;
	}

	flush();
	return segments;
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
