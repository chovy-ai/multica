// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalContextData } from "./local-context-data";
import { LocalConversationService } from "./local-conversation-service";
import { createSideWorkspaceTools, SIDE_WORKSPACE_INSTRUCTIONS } from "./local-side-workspace-tools";
import { startLocalContextMcp } from "./local-context-mcp";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "side-tools-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const scope = { userId: "user", workspaceId: "workspace" };
  const service = new LocalConversationService({ root, apiUrl: "https://example.test", chooseDirectory: async () => null, notify: () => {}, run: async () => ({ output: "reply" }) });
  service.setCurrentUser(scope.userId); cleanups.push(() => service.stop());
  const source = await service.request(scope, "create", { provider: "codex" });
  const side = await service.request(scope, "sideCreate", { id: source.id, requestId: "new-side" });
  const unavailable = async (): Promise<never> => { throw new Error("Cloud must not be queried"); };
  const data = new LocalContextData({ workspaceId: scope.workspaceId, local: { list: () => service.request(scope, "list", {}), read: (id) => service.request(scope, "read", { id }), file: unavailable }, get: unavailable, queryCli: unavailable });
  const control = vi.fn(async () => ({ untrusted_page_content: true, image: { data: Buffer.from("fixture").toString("base64"), mimeType: "image/jpeg" } }));
  const registered = createSideWorkspaceTools({ service, scope, conversationId: source.id, turnId: "turn", data, control });
  return { ...registered, service, scope, source, side, data, control };
}
it("registers offline Side tools and returns real MCP image blocks without base64 in text", async () => {
  const fixture = await setup(); const { source, service, scope } = fixture;
  await service.request(scope, "sideWorkspaceSync", { conversationId: source.id, revision: 1, panelOpen: true, visible: true, selectedTabId: "web:one", tabs: [{ id: "web:one", kind: "web", url: "https://example.test" }] });
  const mcp = await startLocalContextMcp(fixture.data, {}, new AbortController().signal, undefined, fixture.tools); cleanups.push(() => mcp.close());
  const client = new Client({ name: "side-test", version: "1" }); cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }));
  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["side_tabs", "side_focused_tab", "side_read_file", "side_conversation_send", "side_browser_snapshot", "side_browser_screenshot"]));
  const result = await client.callTool({ name: "side_focused_tab", arguments: { include: "screenshot" } });
  expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ untrusted_page_content: true }) }, { type: "image", data: Buffer.from("fixture").toString("base64"), mimeType: "image/jpeg" }]);
});
it("revokes closed conversations, preserves paging and discloses pending executions", async () => {
  const { service, scope, source, side, tools } = await setup();
  await service.request(scope, "sideWorkspaceSync", { conversationId: source.id, revision: 1, panelOpen: true, visible: true, selectedTabId: "side:one", tabs: [{ id: "side:one", kind: "side", sessionId: side.id }] });
  const read = tools.find((tool) => tool.name === "side_conversation_read")!;
  expect(await read.call({ id: side.id, limit: 10 }, new AbortController().signal)).toMatchObject({ source: "local", has_more: false });
  await service.request(scope, "sideWorkspaceSync", { conversationId: source.id, revision: 2, panelOpen: false, visible: false, selectedTabId: null, tabs: [] });
  await expect(read.call({ id: side.id }, new AbortController().signal)).rejects.toThrow("not_in_current_side");
  expect(SIDE_WORKSPACE_INSTRUCTIONS).toContain("Before EACH"); expect(SIDE_WORKSPACE_INSTRUCTIONS).toContain("CAPTCHA and 2FA");
});
it("requires stable request IDs and maps public screenshot/wait options to CDP actions", async () => {
  const { service, scope, source, tools, control } = await setup();
  await service.request(scope, "sideWorkspaceSync", { conversationId: source.id, revision: 1, panelOpen: true, visible: true, selectedTabId: "web:one", tabs: [{ id: "web:one", kind: "web", url: "https://example.test" }] });
  const open = tools.find((tool) => tool.name === "side_browser_open")!;
  await expect(open.call({ url: "https://example.test" }, new AbortController().signal)).rejects.toThrow();
  const screenshot = tools.find((tool) => tool.name === "side_browser_screenshot")!;
  await screenshot.call({ tab_id: "web:one", full_page: true }, new AbortController().signal);
  expect(control).toHaveBeenLastCalledWith(expect.objectContaining({ action: expect.objectContaining({ type: "screenshot", fullPage: true }) }), expect.any(AbortSignal));
});
