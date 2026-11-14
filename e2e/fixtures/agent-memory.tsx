import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { workspaceKeys } from "@multica/core/workspace/queries";
import type { AgentRuntime } from "@multica/core/types";
import { ThemeProvider } from "@multica/ui/components/common/theme-provider";
import { Toaster } from "@multica/ui/components/ui/sonner";
import { RESOURCES } from "@multica/views/locales";
import { AgentMemoryPane } from "../../packages/views/agents/components/memory/agent-memory-pane";
import {
  AgentMemoryConflictError,
  type AgentMemoryAdapter,
  type AgentMemoryEntry,
  type AgentMemoryTree,
} from "../../packages/views/agents/components/memory/types";
import "../../apps/desktop/src/renderer/src/globals.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");
const now = "2026-11-14T09:00:00Z";
let entries: AgentMemoryEntry[] = [
  {
    path: "feedback/root-cause-first.md",
    kind: "feedback",
    projectDir: "",
    title: "Find the root cause first",
    description: "Show evidence before changing code",
    source: "CHOV-117",
    createdAt: now,
    updatedAt: now,
    body: "## Why\n\nA symptom fix can hide the original failure.\n\n## How to apply\n\nRead the relevant code, reproduce the first bad state, then explain the change.",
  },
  {
    path: "project/general/checks.md",
    kind: "project",
    projectDir: "general",
    title: "Run checks before delivery",
    description: "Use the checkout’s managed environment",
    source: "CHOV-117",
    createdAt: now,
    updatedAt: now,
    body: "Run the focused tests and report any gaps.",
  },
  {
    path: "reference/diagnostics.md",
    kind: "reference",
    projectDir: "",
    title: "Latency diagnostics",
    description: "Export timings before changing timeouts",
    source: "CHOV-116",
    createdAt: now,
    updatedAt: now,
    body: "Use the developer log export and correlate request IDs.",
  },
];
if (scenario === "empty") entries = [];
if (scenario === "long")
  entries[0]!.body = Array.from(
    { length: 35 },
    (_, i) =>
      `## Step ${i + 1}\n\nRead the relevant code, reproduce the first bad state, then explain the change.`,
  ).join("\n\n");
let trash: AgentMemoryTree["trash"] = [];
const removed = new Map<string, AgentMemoryEntry>();
Object.defineProperty(window, "daemonAPI", {
  value: {
    getStatus: async () => ({
      state: "running",
      daemonId: "memory-fixture",
      deviceName: "Verification",
    }),
    onStatusChange: () => () => {},
  },
});
const adapter: AgentMemoryAdapter = {
  tree: async () => {
    if (scenario === "failure") throw new Error("Fixture unavailable");
    if (scenario === "loading") await new Promise(() => {});
    return {
      exists: true,
      root: "/verification/profiles/memory/agents/11111111-1111-4111-8111-111111111111/memory",
      index:
        "# Memory\n\n" +
        entries
          .map((e) => `- ${e.path} — ${e.title}: ${e.description}`)
          .join("\n"),
      entries,
      projects: [{ dir: "general", title: "general" }],
      trash,
    };
  },
  read: async (_id, path) => {
    const entry = entries.find((e) => e.path === path);
    if (!entry) throw new Error("Memory entry not found");
    return { ...entry };
  },
  readTrash: async (_id, path) => ({ ...removed.get(path)! }),
  search: async (_id, query) =>
    entries
      .filter((e) =>
        `${e.title} ${e.description} ${e.body}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      .map((e) => ({ path: e.path, title: e.title, snippet: e.description })),
  update: async (_id, input) => {
    if (scenario === "save-failure") throw new Error("Fixture update failed");
    if (scenario === "slow-save")
      await new Promise((resolve) => setTimeout(resolve, 1200));
    const existing = entries.find((e) => e.path === input.path)!;
    if (scenario === "conflict") {
      existing.title = "Updated by another run";
      throw new AgentMemoryConflictError("changed");
    }
    const entry = { ...existing, ...input, updatedAt: "2026-11-14T09:00:01Z" };
    entries = entries.map((e) => (e.path === entry.path ? entry : e));
    return { entry, warnings: [] };
  },
  remove: async (_id, path) => {
    const entry = entries.find((e) => e.path === path)!;
    const trashPath = "20261114T090000Z/" + path;
    removed.set(trashPath, entry);
    trash = [
      ...trash,
      { trashPath, originalPath: path, title: entry.title, deletedAt: now },
    ];
    entries = entries.filter((e) => e.path !== path);
  },
  restore: async (_id, path) => {
    const entry = removed.get(path)!;
    entries = [...entries, entry];
    trash = trash.filter((e) => e.trashPath !== path);
    return entry;
  },
  clear: async (id) => {
    for (const entry of [...entries]) await adapter.remove(id, entry.path);
  },
};
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
client.setQueryData(workspaceKeys.list(), [
  { id: "memory-fixture", slug: "memory", name: "Memory verification" },
]);
const runtime = {
  id: "memory-runtime",
  provider: "claude",
  name: "Claude (Verification)",
  daemon_id: "memory-fixture",
} as AgentRuntime;
createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={params.get("locale") ?? "en"} resources={RESOURCES}>
    <QueryClientProvider client={client}>
      <WorkspaceSlugProvider slug="memory">
        <ThemeProvider forcedTheme={params.get("theme") ?? "light"}>
          <main className="flex h-screen min-w-0 flex-col bg-background text-foreground">
            <header className="border-b p-4 text-title-sm font-semibold">
              Agent memory · Verification
            </header>
            <div className="min-h-0 flex-1">
              <AgentMemoryPane
                agentId="memory-agent"
                runtime={runtime}
                adapter={adapter}
                canEdit={scenario !== "readonly"}
              />
            </div>
          </main>
          <Toaster />
        </ThemeProvider>
      </WorkspaceSlugProvider>
    </QueryClientProvider>
  </I18nProvider>,
);
