// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createRichTextMentionMarkdown, extractRichTextMentionsFromContent } from "@tutti-os/ui-rich-text/core";
import type { RichTextMentionIdentity } from "@tutti-os/ui-rich-text/types";
import { createMulticaContextMentions } from "./context-mentions";
import type { AgentGuiRpcClient, AgentGuiWorkspaceState } from "./protocol";
import { CREATE_TASK_MENTION_ID } from "./task-creation-mention";

function workspaceSource(state: AgentGuiWorkspaceState) {
  const listeners = new Set<() => void>();
  return {
    getWorkspaceState: () => state,
    subscribeWorkspace: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(next: AgentGuiWorkspaceState) { state = next; for (const listener of listeners) listener(); },
    listeners,
  };
}

function avatarWorkspace() {
  return {
    local: true,
    agents: [
      { agent: { id: "design", name: "Design reviewer", description: "Review design" }, provider: "codex", iconUrl: "https://example.test/design.png", canInvoke: true, runtimeBound: true },
      { agent: { id: "code", name: "Code reviewer" }, provider: "codex", iconUrl: "https://example.test/code.png", canInvoke: true, runtimeBound: true },
    ],
    executionTargets: [{ id: "local:codex", name: "Codex", provider: "codex", iconUrl: "", canInvoke: true, runtimeBound: true }],
    sessions: [{ id: "session-1", title: "Review build", agent_id: "design", creator_id: "user-1" }],
  } as unknown as AgentGuiWorkspaceState;
}

it.each(["agent-target", "agent-session"])("restores %s avatars after sending and reopening a local conversation", async (providerId) => {
  const source = workspaceSource(avatarWorkspace());
  const client = { request: vi.fn() } as unknown as AgentGuiRpcClient;
  let service = createMulticaContextMentions(client, { workspaceId: "ws" }, source);
  try {
    const provider = service.getProvider(providerId)!;
    const items = await provider.query({ keyword: "", trigger: "@", context: {} });
    const inserted = provider.toInsertResult(items[0]);
    if (inserted.kind !== "mention") throw new Error("Expected a reference");
    expect(inserted.mention.presentation?.iconUrl).toBe("https://example.test/design.png");
    const markdown = createRichTextMentionMarkdown({ providerId, ...inserted.mention });
    const identity = extractRichTextMentionsFromContent(markdown)[0]!;
    expect(markdown).not.toContain("design.png");
    const expected = { state: "ready", resolved: { label: inserted.mention.label, presentation: { iconUrl: "https://example.test/design.png", agentProviderId: "codex" } } };
    expect(await service.resolve(identity)).toMatchObject(expected);
    service.dispose();
    service = createMulticaContextMentions(client, { workspaceId: "ws" }, source);
    expect(await service.resolve(extractRichTextMentionsFromContent(markdown)[0]!)).toMatchObject(expected);
    expect(source.getWorkspaceState().executionTargets?.map(({ id }) => id)).toEqual(["local:codex"]);
  } finally { service.dispose(); }
  expect(source.listeners.size).toBe(0);
});

it("refreshes visible mention metadata on workspace updates and releases the subscription", async () => {
  const state = avatarWorkspace();
  const source = workspaceSource(state);
  const service = createMulticaContextMentions({ request: vi.fn() } as unknown as AgentGuiRpcClient, { workspaceId: "ws" }, source);
  const identity = { providerId: "agent-target", entityId: "design", label: "Old label", scope: { workspaceId: "ws" } };
  const sessionIdentity = { ...identity, providerId: "agent-session", entityId: "session-1" };
  const unsubscribe = service.subscribe(vi.fn(), identity);
  const unsubscribeSession = service.subscribe(vi.fn(), sessionIdentity);
  try {
    await service.resolve(identity);
    await service.resolve(sessionIdentity);
    expect((await service.resolve({ ...identity, entityId: "code" })).resolved?.presentation?.iconUrl).toBe("https://example.test/code.png");
    source.update({ ...state, agents: state.agents.map((entry) => entry.agent.id === "design" ? { ...entry, agent: { ...entry.agent, name: "Updated reviewer" }, provider: "claude", iconUrl: "https://example.test/new.png" } : entry) });
    await vi.waitFor(() => {
      expect(service.getSnapshot(identity).resolved).toMatchObject({ label: "Updated reviewer", presentation: { iconUrl: "https://example.test/new.png", agentProviderId: "claude" } });
      expect(service.getSnapshot(sessionIdentity).resolved?.presentation?.iconUrl).toBe("https://example.test/new.png");
    });
    source.update({ ...source.getWorkspaceState(), sessions: state.sessions.map((entry) => ({ ...entry, title: "Renamed conversation" })) });
    await vi.waitFor(() => expect(service.getSnapshot(sessionIdentity).resolved?.label).toBe("Renamed conversation"));
    source.update({ ...source.getWorkspaceState(), agents: state.agents.map((entry) => ({ ...entry, iconUrl: "" })) });
    await vi.waitFor(() => expect(service.getSnapshot(identity).resolved?.presentation?.iconUrl).toBeFalsy());
    source.update({ ...state, agents: [] });
    await vi.waitFor(() => expect(service.getSnapshot(identity).resolved).toEqual({ label: "Old label" }));
  } finally { unsubscribe(); unsubscribeSession(); service.dispose(); }
  expect(source.listeners.size).toBe(0);
});

it("does not borrow an avatar from the current workspace for a foreign or missing identity", async () => {
  const service = createMulticaContextMentions({ request: vi.fn() } as unknown as AgentGuiRpcClient, { workspaceId: "ws" }, workspaceSource(avatarWorkspace()));
  try {
    const identities: RichTextMentionIdentity[] = [
      { providerId: "agent-target", entityId: "design", label: "Foreign agent", scope: { workspaceId: "other" } },
      { providerId: "agent-session", entityId: "session-1", label: "Foreign session", scope: { workspaceId: "other", agentTargetId: "design" } },
      { providerId: "agent-target", entityId: "missing", label: "Missing agent", scope: { workspaceId: "ws" } },
    ];
    for (const identity of identities) expect((await service.resolve(identity)).resolved).toEqual({ label: identity.label });
  } finally { service.dispose(); }
});

it("queries real workspace identities for all three categories and inserts scoped references", async () => {
  const request = vi.fn().mockResolvedValue([{ id: "issue-1", label: "DEV-1 Review", status: "qa", statusLabel: "等待验收", statusCategory: "started" }]);
  const state = {
    agents: [{ agent: { id: "agent-1", name: "设计评审师", description: "Review software" }, provider: "codex", canInvoke: true, runtimeBound: true }],
    sessions: [{ id: "session-1", title: "Review build", agent_id: "agent-1", creator_id: "user-1" }],
  } as unknown as AgentGuiWorkspaceState;
  const service = createMulticaContextMentions({ request } as unknown as AgentGuiRpcClient, { workspaceId: "ws-1" }, workspaceSource(state));
  try {
    expect(service.listProviders().map((provider) => provider.id)).toEqual(["agent-session", "workspace-issue", "agent-target"]);
    for (const [id, entityId] of [["agent-session", "session-1"], ["workspace-issue", "issue-1"], ["agent-target", "agent-1"]]) {
      const provider = service.getProvider(id)!;
      const items = await provider.query({ keyword: "", trigger: "@", context: {}, maxResults: 10 });
      const inserted = provider.toInsertResult(items.find((item) => provider.getItemKey(item) === entityId));
      expect(inserted.kind).toBe("mention");
      if (inserted.kind !== "mention") throw new Error("Expected a reference");
      if (id === "workspace-issue") expect(inserted.mention.presentation).toMatchObject({ status: "qa", statusLabel: "等待验收", multicaStatusCategory: "started" });
      const markdown = createRichTextMentionMarkdown({ providerId: id!, ...inserted.mention });
      expect(extractRichTextMentionsFromContent(markdown)[0]).toMatchObject({ providerId: id, entityId, scope: { workspaceId: "ws-1" } });
    }
    expect(request).toHaveBeenCalledWith("context.tasks", { query: "", limit: 10 }, { signal: undefined });
    expect(await service.getProvider("agent-session")!.query({ keyword: "missing", trigger: "@", context: {} })).toEqual([]);
    expect(await service.getProvider("agent-target")!.query({ keyword: "评审 software", trigger: "@", context: {} })).toHaveLength(1);
    const controller = new AbortController(); controller.abort();
    await expect(service.getProvider("workspace-issue")!.query({ keyword: "", trigger: "@", context: {}, abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  } finally { service.dispose(); }
});

it("offers task creation before existing tasks, including an empty result, and carries the search as the title", async () => {
  const request = vi.fn().mockResolvedValue([]);
  const service = createMulticaContextMentions({ request } as unknown as AgentGuiRpcClient, { workspaceId: "ws", locale: "en", local: true }, workspaceSource({ agents: [], sessions: [] }));
  try {
    const provider = service.getProvider("workspace-issue")!;
    const items = await provider.query({ keyword: "Review interface", trigger: "@", context: {} });
    expect(items).toHaveLength(1);
    expect(provider.getItemKey(items[0])).toBe(CREATE_TASK_MENTION_ID);
    expect(provider.getItemLabel(items[0])).toBe("New task: Review interface");
    const inserted = provider.toInsertResult(items[0]);
    expect(inserted).toMatchObject({ kind: "mention", mention: { entityId: CREATE_TASK_MENTION_ID, label: "New task: Review interface", presentation: { description: "Review interface" } } });
    if (inserted.kind !== "mention") throw new Error("Expected an action mention");
    expect(extractRichTextMentionsFromContent(createRichTextMentionMarkdown({ providerId: "workspace-issue", ...inserted.mention }))[0]).toMatchObject({ entityId: CREATE_TASK_MENTION_ID, scope: { workspaceId: "ws" } });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("context.tasks");
  } finally { service.dispose(); }
});

it("does not offer the local MCP action in a cloud-only agent view", async () => {
  const service = createMulticaContextMentions({ request: vi.fn().mockResolvedValue([]) } as unknown as AgentGuiRpcClient, { workspaceId: "ws", local: false }, workspaceSource({ agents: [], sessions: [] }));
  try { expect(await service.getProvider("workspace-issue")!.query({ keyword: "", trigger: "@", context: {} })).toEqual([]); }
  finally { service.dispose(); }
});

it("keeps separately defined agents distinct even when they share the same Codex provider",async()=>{
  const state={agents:[{agent:{id:"design",name:"设计评审师",description:"Review design"},provider:"codex",canInvoke:true,runtimeBound:true},{agent:{id:"code",name:"代码审查师",description:"Review code"},provider:"codex",canInvoke:true,runtimeBound:true}],sessions:[]} as unknown as AgentGuiWorkspaceState;
  const service=createMulticaContextMentions({request:vi.fn()} as unknown as AgentGuiRpcClient,{workspaceId:"ws"},workspaceSource(state));
  try {
    const provider=service.getProvider("agent-target")!;
    const results=await provider.query({keyword:"",trigger:"@",context:{}});
    expect(results.map((item)=>provider.getItemLabel(item))).toEqual(["设计评审师","代码审查师"]);
    const inserted=provider.toInsertResult(results[1]);
    expect(inserted).toMatchObject({kind:"mention",mention:{entityId:"code",scope:{workspaceId:"ws",agentTargetId:"code"}}});
  } finally {service.dispose();}
});

it("omits execution tool entries from agent mentions while retaining agents that use those tools", async () => {
  const state = {
    agents: [
      { agent: { id: "codex", name: "Codex", instructions: "Local execution defaults" }, provider: "codex" },
      { agent: { id: "claude", name: "Claude Code" }, provider: "claude" },
      { agent: { id: "claude-alias", name: "  ClaudeCode  " }, provider: "claude" },
      { agent: { id: "review", name: "Codex 代码审查师" }, provider: "codex", canInvoke: true, runtimeBound: true },
      { agent: { id: "design", name: "交互评审师" }, provider: "claude", canInvoke: true, runtimeBound: true },
      { agent: { id: "archived", name: "旧评审师", archived_at: "2026-10-23T00:00:00Z" }, provider: "codex" },
    ],
    sessions: [{ id: "session-1", title: "Existing Codex conversation", agent_id: "codex" }],
  } as unknown as AgentGuiWorkspaceState;
  const service = createMulticaContextMentions({ request: vi.fn() } as unknown as AgentGuiRpcClient, { workspaceId: "ws" }, workspaceSource(state));
  try {
    const provider = service.getProvider("agent-target")!;
    const results = await provider.query({ keyword: "", trigger: "@", context: {} });
    expect(results.map((item) => provider.getItemKey(item))).toEqual(["review", "design"]);
    expect(await provider.query({ keyword: "claudecode", trigger: "@", context: {} })).toEqual([]);
    expect((await provider.query({ keyword: "codex", trigger: "@", context: {} })).map((item) => provider.getItemKey(item))).toEqual(["review"]);
    expect(await service.getProvider("agent-session")!.query({ keyword: "Codex", trigger: "@", context: {} })).toHaveLength(1);
    expect(state.agents).toHaveLength(6);
  } finally { service.dispose(); }
});
