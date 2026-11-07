// @vitest-environment node
import { expect, it } from "vitest";
import { conversationChangeDetailSchema, conversationResourcesSchema } from "./resources";

const file = { id: "a", cwd: "/repo", path: "a", kind: "future-kind", changed: true, initial_exists: false, current_exists: true, turn_id: "t", added: 1, deleted: 0 };
const page = { revision: 1, coverage: "future-coverage", recorded_from: "", files: [file], next_cursor: null };
it("accepts future resource enums and defaults optional attachment metadata", () => {
 expect(conversationResourcesSchema.parse(page)).toMatchObject({ attachments: [], reason: "", files: [{ reason: "", kind: "future-kind" }] });
 expect(conversationChangeDetailSchema.safeParse({ revision: 1, file, patch: "", before: "", after: "new" }).success).toBe(true);
});
it("rejects malformed resource lists and content before the UI consumes them", () => {
 for (const malformed of [{ ...page, revision: -1 }, { ...page, files: [{ ...file, added: -1 }] }, { ...page, files: [{ ...file, path: "" }] }, { ...page, next_cursor: 5 }]) expect(conversationResourcesSchema.safeParse(malformed).success).toBe(false);
 expect(conversationChangeDetailSchema.safeParse({ revision: 1, file, patch: {}, before: "", after: "" }).success).toBe(false);
});
