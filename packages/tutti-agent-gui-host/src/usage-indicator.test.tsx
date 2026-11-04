// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentGuiHostEvent, AgentGuiRpcClient } from "./protocol";
import { UsageIndicator } from "./usage-indicator";

let root: Root;
let container: HTMLDivElement;
const listeners = new Set<(event: AgentGuiHostEvent) => void>();
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
let request: ReturnType<typeof vi.fn<Request>>;
let client: AgentGuiRpcClient;
const usage = { provider: "codex", context: { usedTokens: 100, limitTokens: 1000, model: null, updatedAt: null }, account: { status: "available", plan: "pro", windows: [], updatedAt: null } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  request = vi.fn<Request>(async (method, params) => method === "usage.read" ? usage : method === "session.compact" ? { turnId: `turn-${params.requestId}` } : undefined);
  client = { request: request as AgentGuiRpcClient["request"], subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); listeners.clear(); vi.unstubAllGlobals(); });
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function renderUsage(props: Partial<ComponentProps<typeof UsageIndicator>> = {}) {
  await act(async () => root.render(<UsageIndicator client={client} agentId="local:codex" sessionId="conversation" chinese={false} busy={false} active {...props} />));
}
async function open() { await act(async () => button("Usage").click()); }
async function complete(status = "completed", sessionId = "conversation") {
  const id = request.mock.calls.find(([method]) => method === "session.compact")![1].requestId;
  await act(async () => {
    const event: AgentGuiHostEvent = { type: "local.events", sessionId, message: { version: 2, type: "conversation.events", conversation_id: sessionId, from_seq: 1, to_seq: 1,
      events: [{ seq: 1, turn_id: `turn-${id}`, turn_seq: 1, item_id: null, type: "turn.completed", final: true, created_at: "2026-10-29T12:00:00Z", payload: { status, error: { kind: "compaction_failed", message: "Not enough history" } } }] } };
    for (const listener of listeners) listener(event);
  });
}

it.each([
  [0, "0"], [999, "999"], [1000, "1k"], [1049, "1k"], [1050, "1.1k"],
  [10049, "10k"], [10050, "10.1k"], [65918, "65.9k"], [785685, "785.7k"],
  [999999, "1000k"], [1000000, "1000k"], [1234567, "1234.6k"],
])("shortens %s context tokens to %s without a reported limit", async (usedTokens, expected) => {
  request.mockResolvedValue({ ...usage, context: { ...usage.context, usedTokens, limitTokens: null } });
  await renderUsage();
  expect(button("Usage").textContent).toBe(`Context ${expected}`);
});

it.each([false, true])("keeps exact tokens in details and account remaining alongside the compact summary (Chinese: %s)", async (chinese) => {
  request.mockResolvedValue({
    ...usage, provider: "claude", context: { ...usage.context, usedTokens: 65918, limitTokens: null },
    account: { ...usage.account, windows: [{ id: "five_hour", label: "5h", usedPercent: 44 }] },
  });
  await renderUsage({ chinese, agentId: "local:claude" });
  const trigger = button(chinese ? "用量" : "Usage");
  expect(trigger.textContent).toBe(chinese ? "上下文 65.9k剩余 56%" : "Context 65.9kleft 56%");
  await act(async () => trigger.click());
  expect(document.querySelector(".multica-usage-detail")?.textContent).toBe(`65,918 · ${chinese ? "上限未提供" : "Limit not reported"} tokens`);
});

it("retains percentage summaries and exact used/limit details when the context limit is known", async () => {
  await renderUsage();
  expect(button("Usage").textContent).toBe("Context 10%");
  await open();
  expect(document.querySelector(".multica-usage-detail")?.textContent).toBe("100 / 1,000 tokens");
});

it("retains the empty-data label when no context count is available", async () => {
  request.mockResolvedValue({ ...usage, context: { ...usage.context, usedTokens: null, limitTokens: null } });
  await renderUsage();
  expect(button("Usage").textContent).toBe("Usage");
});

it("waits for native completion, prevents duplicate clicks and refreshes usage after compaction", async () => {
  await renderUsage(); await open();
  await act(async () => { button("Compact").click(); button("Compact").click(); });
  expect(request.mock.calls.filter(([method]) => method === "session.compact")).toHaveLength(1);
  expect(button("Compact").disabled).toBe(true);
  expect(document.body.textContent).not.toContain("Conversation context compacted");
  await complete("completed", "another-conversation");
  expect(button("Compact").disabled).toBe(true);
  await complete();
  expect(button("Compact").disabled).toBe(false);
  expect(document.body.textContent).toContain("Conversation context compacted");
  expect(request).toHaveBeenCalledWith("usage.read", expect.objectContaining({ sessionId: "conversation", force: true }));
});

it.each([{ sessionId: null }, { busy: true }, { disabled: true }, { active: false }])("disables compaction for $sessionId $busy $disabled $active", async (props) => {
  await renderUsage(props); await open();
  expect(button("Compact").disabled).toBe(true);
  await act(async () => button("Compact").click());
  expect(request.mock.calls.some(([method]) => method === "session.compact")).toBe(false);
});

it("shows provider errors and allows an explicit retry", async () => {
  await renderUsage(); await open();
  await act(async () => button("Compact").click());
  await complete("failed");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Not enough history");
  expect(button("Compact").disabled).toBe(false);
});

it("discards completion from a conversation the user has left", async () => {
  await renderUsage(); await open();
  await act(async () => button("Compact").click());
  await renderUsage({ sessionId: "different" });
  await complete();
  expect(document.body.textContent).not.toContain("Conversation context compacted");
  expect(request.mock.calls.some(([method]) => method === "host.showMessage")).toBe(false);
});

it("keeps a rejected command visible as an error", async () => {
  await renderUsage(); await open();
  const original = request.getMockImplementation()!;
  request.mockImplementation((method, params) => method === "session.compact" ? Promise.reject(new Error("Runtime unavailable")) : original(method, params));
  await act(async () => button("Compact").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Runtime unavailable");
  expect(button("Compact").disabled).toBe(false);
});

it.each([false, true])("reads durable completion when the event was missed (reconnect: %s)", async (reconnect) => {
  const original = request.getMockImplementation()!;
  let completed = !reconnect;
  request.mockImplementation(async (method, params) => {
    if (method !== "local.snapshot") return original(method, params);
    const requestId = request.mock.calls.find(([name]) => name === "session.compact")![1].requestId;
    return { snapshot: {
      version: 2, store_generation: "g1", snapshot_seq: 2,
      conversation: { conversation_id: "conversation", summary_seq: 1, provider: "codex", title: "", status: "idle", pinned: false, archived: false, updated_at: "2026-10-29T12:00:00Z" },
      turns: [{ id: `turn-${requestId}`, turn_index: 1, status: completed ? "completed" : "running", started_at: "2026-10-29T12:00:00Z", messages: [], events: [] }],
    } };
  });
  await renderUsage(); await open();
  await act(async () => button("Compact").click());
  if (reconnect) {
    expect(button("Compact").disabled).toBe(true);
    completed = true;
    await act(async () => {
      for (const listener of listeners) listener({ type: "local.events", sessionId: "conversation", message: { version: 2, type: "subscription.status", conversation_id: "conversation", status: "live" } });
    });
  }
  expect(button("Compact").disabled).toBe(false);
  expect(document.body.textContent).toContain("Conversation context compacted");
});
