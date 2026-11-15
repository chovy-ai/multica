// @vitest-environment node
import { expect, it } from "vitest";
import { conversationOrderGroupKey, conversationOrderScopeKey, createConversationOrderStore } from "./local-conversation-order-store";

const scope = { apiUrl: "https://api.test", userId: "user", workspaceId: "workspace", deviceId: "local" };
const order = { pinned: ["p"], unpinned: ["b", "a"] };
const setup = () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  return { entries, storage, store: createConversationOrderStore(storage) };
};

it("restores only ID order on restart and isolates API, account, workspace, device and group", () => {
  const { store, storage } = setup();
  const key = conversationOrderScopeKey(scope);
  store.getState().setOrder(key, null, order);
  store.getState().setOrder(key, "folder", { pinned: [], unpinned: ["c"] });
  const reopened = createConversationOrderStore(storage).getState();
  expect(reopened.ordersByScope[key]).toEqual({ [conversationOrderGroupKey(null)]: order, [conversationOrderGroupKey("folder")]: { pinned: [], unpinned: ["c"] } });
  for (const field of ["apiUrl", "userId", "workspaceId", "deviceId"] as const) {
    expect(reopened.ordersByScope[conversationOrderScopeKey({ ...scope, [field]: "other" })]).toBeUndefined();
  }
  expect(conversationOrderScopeKey({ ...scope, apiUrl: scope.apiUrl + "/" })).toBe(key);
  expect(conversationOrderGroupKey("null")).not.toBe(conversationOrderGroupKey(null));
});

it("discards corrupt group preferences while keeping valid orders", () => {
  const { storage, entries } = setup();
  entries.set("multica_local_conversation_order", JSON.stringify({ version: 0, state: { ordersByScope: {
    scope: { valid: order, duplicate: { pinned: [], unpinned: ["a", "a"] }, missing: { pinned: [] }, mixed: { pinned: [], unpinned: [null] } },
  } } }));
  expect(createConversationOrderStore(storage).getState().ordersByScope).toEqual({ scope: { valid: order } });
});
