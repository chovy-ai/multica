import { createRichTextMentionService } from "@tutti-os/ui-rich-text/service";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import type { AgentGuiContextItem, AgentGuiInitSnapshot, AgentGuiRpcClient, AgentGuiWorkspaceState } from "./protocol";
import { CREATE_TASK_MENTION_ID } from "./task-creation-mention";

const executionToolNames = new Set(["codex", "claudecode"]);

export function createMulticaContextMentions(
  client: AgentGuiRpcClient,
  initial: Pick<AgentGuiInitSnapshot, "workspaceId"> & Partial<Pick<AgentGuiInitSnapshot, "locale" | "local">>,
  source: { getWorkspaceState(): AgentGuiWorkspaceState; subscribeWorkspace(listener: () => void): () => void },
) {
  const itemLabel = (item: AgentGuiContextItem) => item.id === CREATE_TASK_MENTION_ID && item.description ? `${item.label}${initial.locale === "en" ? ": " : "："}${item.description}` : item.label;
  const providers = ["agent-session", "workspace-issue", "agent-target"].map((id): AgentContextMentionProvider<AgentGuiContextItem> => ({
    id, trigger: "@",
    async query(input) {
      input.abortSignal?.throwIfAborted();
      const limit = Math.min(50, Math.max(1, input.maxResults ?? 30));
      if (id === "workspace-issue") {
        const tasks = await client.request("context.tasks", { query: input.keyword, limit }, { signal: input.abortSignal });
        if (initial.local !== true) return tasks;
        return [{ id: CREATE_TASK_MENTION_ID, label: initial.locale === "en" ? "New task" : "新建任务", description: input.keyword.trim() }, ...tasks];
      }
      const state = source.getWorkspaceState();
      const agents = new Map(state.agents.map((entry) => [entry.agent.id, entry]));
      const items: AgentGuiContextItem[] = id === "agent-target"
        ? state.agents.filter(({ agent }) => !agent.archived_at && !executionToolNames.has(agent.name.toLocaleLowerCase().replace(/[\s_-]+/g, ""))).sort((left, right) => {
            const configured = (entry: typeof left) => Number(Boolean(entry.agent.instructions?.trim() || entry.agent.description?.trim() || entry.agent.system_key));
            return configured(right) - configured(left);
          }).map(({ agent, provider, iconUrl, canInvoke, runtimeBound }) => ({
            id: agent.id, agentId: agent.id, label: agent.name, description: agent.description ?? undefined, provider, iconUrl,
            status: canInvoke && runtimeBound ? "available" : "unavailable",
          }))
        : state.sessions.map((session) => ({
            id: session.id, label: session.title, userId: session.creator_id, agentId: session.agent_id,
            description: agents.get(session.agent_id)?.agent.name, provider: agents.get(session.agent_id)?.provider,
            iconUrl: agents.get(session.agent_id)?.iconUrl,
          }));
      const words = input.keyword.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      return items.filter((item) => words.every((word) => `${item.label} ${item.description ?? ""}`.toLocaleLowerCase().includes(word))).slice(0, limit);
    },
    getItemKey: (item) => item.id,
    getItemLabel: itemLabel,
    getItemSubtitle: (item) => item.description,
    getItemIconUrl: (item) => item.iconUrl,
    toInsertResult: (item) => ({ kind: "mention", mention: {
      entityId: item.id, label: itemLabel(item),
      scope: { workspaceId: initial.workspaceId, ...(item.userId ? { userId: item.userId } : {}), ...(item.agentId ? { agentTargetId: item.agentId } : {}) },
      presentation: { description: item.description, subtitle: item.description, agentProviderId: item.provider, iconUrl: item.iconUrl, status: item.status, statusLabel: item.statusLabel, multicaStatusCategory: item.statusCategory },
    } }),
    resolveMention: (identity) => {
      if (identity.scope?.workspaceId && identity.scope.workspaceId !== initial.workspaceId) return { label: identity.label };
      if (id !== "agent-target" && id !== "agent-session") return { label: identity.label };
      const state = source.getWorkspaceState();
      const session = id === "agent-session" ? state.sessions.find((entry) => entry.id === identity.entityId) : undefined;
      const agentId = id === "agent-target" ? identity.entityId : session?.agent_id;
      const descriptor = state.agents.find((entry) => entry.agent.id === agentId);
      if (!descriptor) return { label: session?.title ?? identity.label };
      const { agent, provider, iconUrl } = descriptor;
      return {
        label: session?.title ?? agent.name,
        presentation: {
          description: session ? agent.name : agent.description ?? undefined,
          subtitle: session ? agent.name : agent.description ?? undefined,
          agentProviderId: provider,
          iconUrl,
        },
      };
    },
  }));
  const service = createRichTextMentionService({ providers });
  let previous = source.getWorkspaceState();
  const unsubscribe = source.subscribeWorkspace(() => {
    const next = source.getWorkspaceState();
    const agentsChanged = next.agents !== previous.agents;
    const sessionsChanged = next.sessions !== previous.sessions;
    previous = next;
    if (agentsChanged) service.invalidate({ providerId: "agent-target" });
    if (agentsChanged || sessionsChanged) service.invalidate({ providerId: "agent-session" });
  });
  return { ...service, dispose() { unsubscribe(); service.dispose(); } };
}
