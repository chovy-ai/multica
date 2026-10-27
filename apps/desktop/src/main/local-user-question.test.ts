// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalConversationService } from "./local-conversation-service";
import { LocalMulticaContext } from "./local-multica-context";
import { CONTEXT_MCP_TOKEN_ENV } from "./local-context-mcp";
import { userQuestionAnswers, userQuestionSchema } from "./local-user-question";
import type { LocalProviderId } from "@multica/core/local-conversation/protocol";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });
const scope = { userId: "user", workspaceId: "workspace" };
const input = userQuestionSchema.parse({ request_id: "pick-approach", questions: [
  { id: "approach", header: "Approach", question: "Which approach?", options: [{ label: "Simple", description: "Keep the current layout" }, { label: "Detailed" }] },
  { id: "checks", question: "Which checks?", multiSelect: true, options: [{ label: "Keyboard" }, { label: "Layout" }] },
  { id: "note", question: "Any other requirements?" },
] });
const answers = { approach: "Simple", checks: ["Keyboard", "Layout"], note: "Keep the original colors" };

async function fixture(provider: LocalProviderId) {
  const root = await mkdtemp(join(tmpdir(), "multica-question-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const context = new LocalMulticaContext({ root: join(root, "mcp"), apiUrl: "https://example.test", cliPath: join(root, "missing-cli"), readProfile: async () => { throw new Error("No cloud login"); } });
  const run = vi.fn(async (value: Parameters<NonNullable<ConstructorParameters<typeof LocalConversationService>[0]["run"]>>[0]) => {
    expect(value.systemPrompt).toContain("ask_user_question");
    expect(value.mcp?.tools).toContain("ask_user_question");
    expect(value.env?.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe("0");
    expect(JSON.parse(await readFile(value.mcp!.claudeConfigPath, "utf8")).mcpServers.multica_desktop_context.timeout).toBe(3_600_000);
    const client = new Client({ name: "test-owned-provider", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(value.mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${value.env![CONTEXT_MCP_TOKEN_ENV]}` } } }));
    try {
      const [result, replay] = await Promise.all([1, 2].map(() => client.callTool({ name: "ask_user_question", arguments: input })));
      expect(replay).toEqual(result);
      if (result!.isError) throw new Error("Question cancelled");
      return { output: (result!.content as { text: string }[])[0]!.text, sessionId: "test-native-session" };
    } finally { await client.close(); }
  });
  const options = { root: join(root, "history"), apiUrl: "https://example.test", run, find: async () => join(root, "missing-cli"), notify: vi.fn(), chooseDirectory: async () => null,
    prepareContext: (current: typeof scope, signal: AbortSignal, state: Parameters<typeof context.prepare>[2]) => context.prepare(current, signal, state) };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  cleanup.push(() => service.stop());
  const source = await service.request(scope, "create", { provider });
  return { service, source, options };
}

it.each(["codex", "claude"] as const)("waits for real answers over MCP and continues the same %s turn without cloud login", async (provider) => {
  const { service, source, options } = await fixture(provider);
  const sent = await service.request(scope, "send", { id: source.id, content: "Ask me before proceeding" });
  await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.questions).toHaveLength(1));
  const pending = await service.request(scope, "read", { id: source.id });
  expect(pending.turns[0]).toMatchObject({ id: sent.turnId, status: "running", questions: [{ status: "pending", request_id: input.request_id }] });
  expect(pending.messages).toHaveLength(1);
  await expect(service.request(scope, "answerQuestion", { id: source.id, turnId: sent.turnId, requestId: input.request_id, answers: { approach: "Simple" } })).rejects.toThrow("every question");
  await expect(service.request({ ...scope, workspaceId: "other" }, "answerQuestion", { id: source.id, turnId: sent.turnId, requestId: input.request_id, answers })).rejects.toThrow("not found");
  await Promise.all([1, 2].map(() => service.request(scope, "answerQuestion", { id: source.id, turnId: sent.turnId, requestId: input.request_id, answers })));
  await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.status).toBe("completed"));
  const complete = await service.request(scope, "read", { id: source.id });
  expect(JSON.parse(complete.messages[1]!.content)).toEqual({ answersByQuestionId: answers });
  expect(complete.turns[0]?.questions?.[0]).toMatchObject({ status: "answered", answers });
  expect(options.run).toHaveBeenCalledOnce();
  await service.request(scope, "answerQuestion", { id: source.id, turnId: sent.turnId, requestId: input.request_id, answers });
  await expect(service.request(scope, "answerQuestion", { id: source.id, turnId: sent.turnId, requestId: input.request_id, answers: { ...answers, approach: "Changed" } })).rejects.toThrow("different answer");
  await service.stop();
  const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanup.push(() => reopened.stop());
  expect((await reopened.request(scope, "read", { id: source.id })).turns[0]?.questions).toEqual(complete.turns[0]?.questions);
});

it("cancels an unanswered Side question, rejects late replies and does not replay it after restart", async () => {
  const { service, source, options } = await fixture("codex");
  const side = await service.request(scope, "sideCreate", { id: source.id, requestId: "question-side" });
  const sent = await service.request(scope, "send", { id: side.id, content: "Ask in Side" });
  await vi.waitFor(async () => expect((await service.request(scope, "read", { id: side.id })).turns[0]?.questions?.[0]?.status).toBe("pending"));
  await service.flush();
  const reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId); cleanup.push(() => reopened.stop());
  expect((await reopened.request(scope, "read", { id: side.id })).turns[0]).toMatchObject({ status: "failed", questions: [{ status: "cancelled" }] });
  await service.request(scope, "cancel", { id: side.id, turnId: sent.turnId });
  await vi.waitFor(async () => expect((await service.request(scope, "read", { id: side.id })).turns[0]?.questions?.[0]?.status).toBe("cancelled"));
  await expect(service.request(scope, "answerQuestion", { id: side.id, turnId: sent.turnId, requestId: input.request_id, answers })).rejects.toThrow("no longer");
  expect((await service.request(scope, "read", { id: source.id })).turns).toHaveLength(0);
});

it("ends pending questions when the desktop account changes", async () => {
  const { service, source } = await fixture("claude");
  await service.request(scope, "send", { id: source.id, content: "Ask first" });
  await vi.waitFor(async () => expect((await service.request(scope, "read", { id: source.id })).turns[0]?.questions?.[0]?.status).toBe("pending"));
  service.setCurrentUser("other-user");
  await expect(service.request(scope, "read", { id: source.id })).rejects.toThrow("account");
  await service.stop(); service.setCurrentUser(scope.userId);
  expect((await service.request(scope, "read", { id: source.id })).turns[0]).toMatchObject({ status: "cancelled", questions: [{ status: "cancelled" }] });
});

it("validates fixed-choice answers and refuses duplicate question IDs", () => {
  const fixed = userQuestionSchema.parse({ request_id: "fixed", questions: [{ id: "pick", question: "Pick one", options: [{ label: "A" }], allowFreeText: false }] });
  expect(() => userQuestionAnswers(fixed, { pick: "B" })).toThrow("offered");
  expect(() => userQuestionAnswers(fixed, { pick: ["A", "B"] })).toThrow("one answer");
  expect(() => userQuestionSchema.parse({ ...fixed, questions: [fixed.questions[0], fixed.questions[0]] })).toThrow("unique");
});
