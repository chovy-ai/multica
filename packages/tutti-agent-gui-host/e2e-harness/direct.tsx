// Test rig: two GUI instances beside app UI in one document, under the app's own stylesheet.
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../apps/desktop/src/renderer/src/globals.css";
import AgentGuiMount from "../src/mount";
import { createInProcessRpcClient } from "../src/in-process-client";
import { localSourceFromClient } from "../src/runtime/local-snapshot-test-host";
import type { AgentGuiHostEvent, AgentGuiInitSnapshot } from "../src/protocol";

const at = "2026-11-03T10:00:00Z";
const listeners = new Set<(event: AgentGuiHostEvent) => void>();
function snapshot(id: string, theme: "light" | "dark", sidePane: boolean): AgentGuiInitSnapshot {
  const session = { id, workspace_id: "w", creator_id: "u", agent_id: "local:codex", title: id, status: "active", created_at: at, updated_at: at };
  return { workspaceId: "w", workspaceSlug: "w", userId: "u", locale: "en", theme, sidePane, local: true, hostActive: true, hostVisible: true,
    agents: [], sessions: [session], activeSessionId: id, selectedAgentId: "local:codex",
    executionTargets: [{ id: "local:codex", provider: "codex", name: "Codex", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }] } as unknown as AgentGuiInitSnapshot;
}
const storage = new Map<string, string>();
function service(id: string, theme: "light" | "dark", sidePane: boolean) {
  const session = snapshot(id, theme, sidePane).sessions[0]!;
  const request = async (method: string, params: { key?: string; value?: string }) => {
    switch (method) {
      case "workspace.load": return snapshot(id, theme, sidePane);
      case "session.load": return { session, messages: [
        { id: `${id}-q`, chat_session_id: id, role: "user", content: `Question for ${id}`, task_id: `${id}-t`, created_at: at },
        { id: `${id}-a`, chat_session_id: id, role: "assistant", content: `Reply in ${id}`, task_id: `${id}-t`, created_at: at },
      ], tasks: [], pending: {} };
      case "storage.read": return storage.get(params.key!) ?? null;
      case "storage.write": storage.set(params.key!, params.value!); return undefined;
      case "models.list": return { id: "m", runtime_id: "local:codex", status: "completed", supported: true, models: [] };
      case "usage.read": return { provider: "codex", context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [], plan: null, updatedAt: null } };
      case "context.tasks": return [];
      default: return undefined;
    }
  };
  return { request, subscribe(listener: (event: AgentGuiHostEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); } };
}

function Instance({ id, theme, sidePane }: { id: string; theme: "light" | "dark"; sidePane: boolean }) {
  const { connection, source } = useMemo(() => {
    const host = service(id, theme, sidePane);
    return { connection: createInProcessRpcClient(host as never, { interactive: () => true, current: () => true }), source: localSourceFromClient(host as never) };
  }, [id, theme, sidePane]);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-instance={id}><AgentGuiMount client={connection.client} initial={snapshot(id, theme, sidePane)} localConversations={source} /></div>;
}

function Page() {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  return <div className="flex h-dvh bg-background text-foreground">
    <aside data-testid="app-aside" className="flex w-56 shrink-0 flex-col gap-3 border-r p-4 text-sm">
      <button id="toggle" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => setMounted((value) => !value)}>Toggle GUI</button>
      <button id="theme" className="rounded-md border px-3 py-2 text-sm" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}>Toggle theme</button>
      <h1 id="heading" className="text-lg font-semibold">App heading</h1>
      <p id="paragraph" className="text-sm text-muted-foreground">App text must not change when the GUI mounts.</p>
    </aside>
    {mounted && <div key={theme} className="flex min-h-0 min-w-0 flex-1"><Instance id="main-conversation" theme={theme} sidePane={false} /><div className="w-px bg-border" /><Instance id="side-conversation" theme={theme} sidePane /></div>}
  </div>;
}

createRoot(document.getElementById("app-root")!).render(<Page />);
