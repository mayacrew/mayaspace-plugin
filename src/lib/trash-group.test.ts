import { groupFileIdsByOrg } from "./trash-group";

test("groupFileIdsByOrg buckets selected ids per org", () => {
	const rows = [
		{ orgId: "o1", id: "a", path: "a.md", deleted_at: "" },
		{ orgId: "o1", id: "b", path: "b.md", deleted_at: "" },
		{ orgId: "o2", id: "c", path: "c.md", deleted_at: "" },
	];
	const selected = new Set(["a", "c"]);
	expect(groupFileIdsByOrg(rows, selected)).toEqual({ o1: ["a"], o2: ["c"] });
});

test("groupFileIdsByOrg returns empty object when nothing selected", () => {
	expect(groupFileIdsByOrg([], new Set())).toEqual({});
});
