import { PanelRightOpen } from "lucide-react";
import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";
import { ThemeProvider } from "@multica/ui/components/common/theme-provider";
import { createFakeTransport } from "@multica/conversation-client/testing";
import { CONVERSATION_RESOURCES_CAPABILITY } from "@multica/core/local-conversation/resources";
import { LocalSideWorkspace, type SideWorkspaceHandle } from "../../apps/desktop/src/renderer/src/pages/local-side-workspace";
import { LocalDeviceProvider, type LocalDevice } from "../../apps/desktop/src/renderer/src/platform/local-device";
import "../../apps/desktop/src/renderer/src/globals.css";

const scope = { userId: "resource-fixture", workspaceId: "resource-fixture" };
const summary = { conversation_id: "source", summary_seq: 1, provider: "codex", title: "Repair login redirect", cwd: "/project", project_id: null, pinned: false, archived: false, status: "idle", last_message_preview: "Updated redirect validation", turn_count: 1, updated_at: "2026-11-07T10:00:00Z" };
const files = [
  { id: "redirect", path: "src/auth/redirect.ts", kind: "modified", added: 1, deleted: 1 },
  { id: "test", path: "src/auth/redirect.test.ts", kind: "added", added: 1, deleted: 0 },
  { id: "legacy", path: "src/auth/legacy.ts", kind: "deleted", added: 0, deleted: 1 },
  { id: "report", path: "redirect-notes.md", kind: "added", added: 1, deleted: 0 },
].map(file => ({ ...file, cwd: "/project", changed: true, initial_exists: file.kind !== "added", current_exists: file.kind !== "deleted", turn_id: "turn", reason: "" }));
const contents: Record<string, { before: string; after: string; patch: string }> = {
  redirect: { before: "export const redirect = (next: string) => next;\n", after: 'export const redirect = (next: string) => next.startsWith("/") ? next : "/";\n', patch: '--- a/src/auth/redirect.ts\n+++ b/src/auth/redirect.ts\n@@ -1 +1 @@\n-export const redirect = (next: string) => next;\n+export const redirect = (next: string) => next.startsWith("/") ? next : "/";\n' },
  test: { before: "", after: 'expect(redirect("https://example.test")).toBe("/");\n', patch: '--- /dev/null\n+++ b/src/auth/redirect.test.ts\n@@ -0,0 +1 @@\n+expect(redirect("https://example.test")).toBe("/");\n' },
  legacy: { before: "export const legacyRedirect = true;\n", after: "", patch: '--- a/src/auth/legacy.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const legacyRedirect = true;\n' },
  report: { before: "", after: "# Redirect notes\n", patch: '--- /dev/null\n+++ b/redirect-notes.md\n@@ -0,0 +1 @@\n+# Redirect notes\n' },
};
const transport = createFakeTransport(scope, async (_method, path, body) => {
  const url = new URL(path, "http://fixture");
  if (url.pathname === "/sessions") return { scope_seq: 1, summaries: [summary], has_more: false };
  if (url.pathname.endsWith("/snapshot")) return { version: 2, store_generation: "fixture", snapshot_seq: 1, conversation: summary, turns: [] };
  if (url.pathname.endsWith("/resources")) return { revision: 1, coverage: "complete", reason: "", recorded_from: "2026-11-07T10:00:00Z", files, attachments: [{ id: "input", name: "login-reference.md", media_type: "text/markdown", size: 20, source: "input" }], next_cursor: null };
  if (url.pathname.includes("/changes/")) { const id = url.pathname.split("/").at(-1)!; return { revision: 1, file: files.find(file => file.id === id), ...contents[id] }; }
  if (url.pathname === "/preview/locate") { const path = url.searchParams.get("path")!; return { root: "/project", path, name: path.split("/").at(-1), kind: "file" }; }
  if (url.pathname === "/preview/file") { const path = url.searchParams.get("path")!; return { root: "/project", path, name: path.split("/").at(-1), mime_type: "text/markdown", size: 40 }; }
  if (url.pathname.endsWith("/commands")) return { revision: (body as { workspace?: { revision?: number } })?.workspace?.revision };
  if (url.pathname === "/providers") return { providers: [] };
  throw new Error(`Unexpected fixture request ${path}`);
});
transport.capabilities = async () => [CONVERSATION_RESOURCES_CAPABILITY];
transport.storeGeneration = async () => "fixture";
transport.fileUrl = (_scope, path) => `/__resources/content?path=${encodeURIComponent(path)}`;
const device = { id: "local", name: "", transport } as LocalDevice;
Object.defineProperty(window, "desktopAPI", { configurable: true, value: { sideWorkspace: { reconcile: async () => {}, onActivity: () => () => {}, onCommand: () => () => {}, ack: async () => {} }, resourcePreview: (window as unknown as { __resourcePreviewFixture?: unknown }).__resourcePreviewFixture ?? { request: async () => null, subscribe: () => () => {} } } });
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
const key = `multica-side-workspace:${scope.userId}:${scope.workspaceId}:session:source`;
localStorage.setItem(key, JSON.stringify({ tabs: [{ id: "readme", kind: "file", sourceId: "source", location: { root: "/project", path: "/project/README.md", name: "README.md", kind: "file" } }], selected: "readme", open: true }));
if (new URLSearchParams(location.search).has("native")) localStorage.setItem(key, JSON.stringify({ tabs: [{ id: "native-web", kind: "web", sourceId: "source", url: new URL("/__test/native-preview", location.origin).href }], selected: "native-web", open: true }));
const ref = createRef<SideWorkspaceHandle>();
document.body.style.cssText = "margin:0;height:100vh";
createRoot(document.getElementById("root")!).render(<I18nProvider locale="en" resources={RESOURCES}><ThemeProvider forcedTheme={theme}><QueryClientProvider client={new QueryClient()}><LocalDeviceProvider device={device}>
  <div className="flex h-dvh bg-app-shell text-foreground">
    <aside className="hidden w-44 shrink-0 flex-col gap-4 border-r p-4 xl:flex"><b>Multica</b><span>Inbox</span><span>Tasks</span><span className="rounded-md bg-surface-selected p-2">Conversations</span><span>Agents</span></aside>
    <aside className="hidden w-52 shrink-0 border-r p-3 lg:block"><h2 className="mb-6 text-body font-medium">Conversations</h2><div className="rounded-md bg-surface-selected p-3 text-label">Repair login redirect<p className="mt-2 text-caption text-muted-foreground">Codex · Just now</p></div></aside>
    <main className="min-h-0 min-w-0 flex-1"><LocalSideWorkspace ref={ref} scope={scope} slug="fixture" sessionId="source" provider="codex" sessions={[]} chinese={false} active onSelectSource={() => {}} onReference={() => {}} onOpenTask={() => {}} onShowMessage={message => { document.body.dataset.error = message; }}>
      {(_visible, resources) => <div className="flex h-full flex-col"><header className="flex h-12 items-center gap-2 border-b px-3 text-body font-medium"><span className="min-w-0 flex-1 truncate">Repair login redirect</span>{resources}<button onClick={() => ref.current?.toggle()} aria-label="Toggle original workspace"><PanelRightOpen className="size-4" /></button></header><div className="flex-1 p-5 text-body"><p className="rounded-xl bg-surface-hover p-3">Keep the original destination after login, and add tests.</p><h3 className="mb-3 mt-6 font-medium">Codex</h3><p>I updated redirect validation and added tests.</p><button className="mt-3 text-brand" onClick={() => ref.current?.openChanges("redirect")}>View changes</button></div><textarea aria-label="Main draft" className="m-4 min-h-24 rounded-xl border bg-surface p-3 text-body" placeholder="Continue the conversation..." /></div>}
    </LocalSideWorkspace></main>
  </div>
</LocalDeviceProvider></QueryClientProvider></ThemeProvider></I18nProvider>);
