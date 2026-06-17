/**
 * 외부 디스크 쓰기를 live 세션의 ytext에 머지(순수 함수).
 *
 * live(Hocuspocus) 세션이 열린 동안 외부 프로세스(AI CLI, Finder 복사 등)가
 * 디스크에 쓰면 그 변경이 ytext로 들어올 경로가 없어 조용히 유실된다. 이 함수는
 * 디스크 내용으로 ytext를 수렴시켜(전체 교체) 바인딩된 에디터와 모든 협업자에게
 * 전파되게 한다.
 *
 * 전체 교체를 쓰는 이유: diff 기반 부분 적용은 동시에 들어오는 원격 op과 위치가
 * 어긋나 손상될 위험이 있다. 전체 교체를 단일 트랜잭션으로 감싸면 협업자는 한 번의
 * 일관된 업데이트만 본다. (줄 단위 diff 적용은 후속 과제 — markdown-diff 참고.)
 *
 * 호출자가 echo 가드를 끝낸 뒤(자기 쓰기 hash 비교) 호출해야 한다. 여기서는
 * 추가로 "이미 같으면 트랜잭션 자체를 만들지 않는다"로 불필요한 update를 막는다.
 */

interface YTextLike {
	toString(): string;
	delete(index: number, length: number): void;
	insert(index: number, text: string): void;
}

interface YDocLike {
	transact(fn: () => void): void;
}

/** ytext를 disk 내용으로 전체 교체한다. 이미 같으면 무동작. 변경했으면 true. */
export function mergeDiskIntoYtext(doc: YDocLike, ytext: YTextLike, diskContent: string): boolean {
	const current = ytext.toString();
	if (current === diskContent) return false;

	doc.transact(() => {
		ytext.delete(0, current.length);
		ytext.insert(0, diskContent);
	});
	return true;
}
