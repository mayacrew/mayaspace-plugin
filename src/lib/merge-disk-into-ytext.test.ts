import * as Y from "yjs";
import { mergeDiskIntoYtext } from "./merge-disk-into-ytext";

function makeYtext(initial: string): { doc: Y.Doc; ytext: Y.Text } {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	if (initial) ytext.insert(0, initial);
	return { doc, ytext };
}

describe("mergeDiskIntoYtext", () => {
	test("ytext가 디스크 내용과 다르면 디스크 내용으로 수렴시키고 true를 반환한다", () => {
		const { doc, ytext } = makeYtext("old live content");

		const changed = mergeDiskIntoYtext(doc, ytext, "disk content from AI");

		expect(ytext.toString()).toBe("disk content from AI");
		expect(changed).toBe(true);
	});

	test("ytext가 이미 디스크 내용과 같으면 아무것도 하지 않고 false를 반환한다(echo/no-op)", () => {
		const { doc, ytext } = makeYtext("same content");
		let observed = false;
		ytext.observe(() => { observed = true; });

		const changed = mergeDiskIntoYtext(doc, ytext, "same content");

		expect(ytext.toString()).toBe("same content");
		expect(changed).toBe(false);
		expect(observed).toBe(false); // 트랜잭션 자체가 없어야 한다 — 관찰 이벤트 0
	});

	test("빈 ytext에 디스크 내용을 머지하면 그대로 채운다", () => {
		const { doc, ytext } = makeYtext("");

		const changed = mergeDiskIntoYtext(doc, ytext, "fresh content");

		expect(ytext.toString()).toBe("fresh content");
		expect(changed).toBe(true);
	});

	test("디스크가 비면 ytext도 비운다(외부에서 파일을 비운 경우)", () => {
		const { doc, ytext } = makeYtext("had content");

		const changed = mergeDiskIntoYtext(doc, ytext, "");

		expect(ytext.toString()).toBe("");
		expect(changed).toBe(true);
	});

	test("전체 교체는 단일 트랜잭션 — 협업자는 한 번의 업데이트만 관찰한다", () => {
		const { doc, ytext } = makeYtext("aaa");
		let updateCount = 0;
		doc.on("update", () => { updateCount++; });

		mergeDiskIntoYtext(doc, ytext, "bbb");

		expect(ytext.toString()).toBe("bbb");
		expect(updateCount).toBe(1);
	});
});
