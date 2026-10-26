// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createConversationLayoutStore } from "./local-conversation-layout";

function setup() {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  return { entries, storage, store: createConversationLayoutStore(storage) };
}

describe("conversation list width preference", () => {
  it("restores the chosen pixel width from durable storage", () => {
    const { storage, store } = setup();
    store.getState().setSessionListWidth(350.2);
    expect(createConversationLayoutStore(storage).getState().sessionListWidth).toBe(350);
  });

  it("keeps the previous preference for hidden, nonfinite, or out-of-bounds sizes", () => {
    const { store } = setup();
    store.getState().setSessionListWidth(400);
    for (const width of [0, 239, 481, NaN, Infinity]) store.getState().setSessionListWidth(width);
    expect(store.getState().sessionListWidth).toBe(400);
  });

  it("ignores malformed saved widths", () => {
    const { entries, storage } = setup();
    for (const sessionListWidth of [null, "350", {}, -1, 900]) {
      entries.set("multica_local_conversation_width", JSON.stringify({ state: { sessionListWidth }, version: 0 }));
      expect(createConversationLayoutStore(storage).getState().sessionListWidth).toBe(268);
    }
  });
});
