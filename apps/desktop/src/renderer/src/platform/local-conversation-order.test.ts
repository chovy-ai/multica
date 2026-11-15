// @vitest-environment node
import { expect, it } from "vitest";
import { orderLocalConversations, reorderLocalConversations } from "./local-conversation-order";
import type { LocalSessionEntry } from "./local-conversation-projects";

const entry = (id: string, pinned = false) => ({ id, pinned }) as LocalSessionEntry;
const ids = (entries: LocalSessionEntry[]) => entries.map((item) => item.id);

it("keeps default recency until a move, then preserves manual order across activity, additions and deletion", () => {
  const initial = [entry("pin", true), entry("a"), entry("b"), entry("c")];
  expect(orderLocalConversations(initial)).toBe(initial);
  const order = reorderLocalConversations(initial, undefined, "c", "a");
  expect(order).toEqual({ pinned: ["pin"], unpinned: ["c", "a", "b"] });
  expect(ids(initial)).toEqual(["pin", "a", "b", "c"]);
  expect(ids(orderLocalConversations([entry("pin", true), entry("b"), entry("a"), entry("c")], order))).toEqual(["pin", "c", "a", "b"]);
  expect(ids(orderLocalConversations([entry("new-pin", true), entry("pin", true), entry("new"), entry("b"), entry("c")], order))).toEqual(["new-pin", "pin", "new", "c", "b"]);
  expect(reorderLocalConversations(initial, order, "c", "b")?.unpinned).toEqual(["a", "b", "c"]);
});

it("rejects missing, identical and differently pinned targets without changing the preference", () => {
  const sessions = [entry("pin", true), entry("a"), entry("b")];
  for (const [active, over] of [["a", "missing"], ["missing", "b"], ["a", "a"], ["a", "pin"]]) {
    expect(reorderLocalConversations(sessions, undefined, active!, over!)).toBeUndefined();
  }
});

it("projects filtered lists without discarding hidden or archived IDs on the next move", () => {
  const sessions = [entry("a"), entry("hidden"), entry("archived"), entry("b"), entry("c")];
  const order = reorderLocalConversations(sessions, undefined, "c", "a")!;
  expect(ids(orderLocalConversations(sessions.filter((item) => ["a", "b", "c"].includes(item.id)), order))).toEqual(["c", "a", "b"]);
  const moved = reorderLocalConversations(sessions, order, "a", "b")!;
  expect(moved.unpinned).toEqual(["c", "hidden", "archived", "b", "a"]);
});
