// @vitest-environment node
import { expect, it } from "vitest";
import { chatAuthoredPrompt, CHAT_CONTEXT_SNAPSHOT_END, CHAT_CONTEXT_SNAPSHOT_START } from "./context-snapshot";

it("extracts only a complete generated suffix and preserves ordinary or incomplete authored text", () => {
  const authored = "Review the referenced task";
  const complete = `${authored}${CHAT_CONTEXT_SNAPSHOT_START}Task description${CHAT_CONTEXT_SNAPSHOT_END}`;
  expect(chatAuthoredPrompt(complete)).toBe(authored);
  expect(chatAuthoredPrompt(authored)).toBe(authored);
  expect(chatAuthoredPrompt(`${authored}${CHAT_CONTEXT_SNAPSHOT_START}unfinished`)).toBe(`${authored}${CHAT_CONTEXT_SNAPSHOT_START}unfinished`);
  expect(chatAuthoredPrompt(`${complete}\nMore authored text`)).toBe(`${complete}\nMore authored text`);
});
