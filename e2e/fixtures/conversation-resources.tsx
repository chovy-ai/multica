import { ApiClient, setApiInstance } from "@multica/core/api";
import { PanelRightOpen } from "lucide-react";
import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";
import { ThemeProvider } from "@multica/ui/components/common/theme-provider";
import { createFakeTransport } from "@multica/conversation-client/testing";
import { conversationResourcesSchema, conversationChangeDetailSchema, CONVERSATION_RESOURCES_CAPABILITY } from "@multica/core/local-conversation/resources";
import { LocalSideWorkspace, type SideWorkspaceHandle } from "../../apps/desktop/src/renderer/src/pages/local-side-workspace";
import { LocalDeviceProvider, type LocalDevice } from "../../apps/desktop/src/renderer/src/platform/local-device";
import { conversationService } from "../../apps/desktop/src/renderer/src/platform/conversation-services";
import "../../apps/desktop/src/renderer/src/globals.css";

setApiInstance(new ApiClient(location.origin));
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "";
const proofName = params.get("proof");
// Evidence is generated after Vite starts; do not freeze it into an asset glob.
const proof = proofName ? await fetch(new URL(/* @vite-ignore */ `../../.tmp/chov96-runner/${proofName}.json`, import.meta.url)).then(response => response.json()) : null;

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
function scrollContents(revised: boolean) {
  const lines = [contents.redirect!.before.trim(), ...Array.from({ length: 2999 }, (_, i) => `// ${revised && i === 2998 ? "revision-two" : `fixture-line-${i}`}`)];
  return { before: contents.redirect!.before, after: lines.join("\n") + "\n", patch: `--- a/src/auth/redirect.ts\n+++ b/src/auth/redirect.ts\n@@ -1 +1,3000 @@\n-${contents.redirect!.before.trim()}\n${lines.map(line => `+${line}\n`).join("")}` };
}
if (scenario === "scroll") contents.redirect = scrollContents(false);
const basePage = proof ? conversationResourcesSchema.parse(proof.page) : { revision: 1, coverage: "complete", reason: "", recorded_from: "2026-11-07T10:00:00Z", files, attachments: [{ id: "input", name: "login-reference.md", media_type: "text/markdown", size: 20, source: "input" }], next_cursor: null };
const resourceFiles = scenario === "paged" ? Array.from({ length: 203 }, (_, i) => ({ ...files[0], id: `early-${i}`, path: `early/file-${String(i).padStart(3, "0")}.ts`, turn_id: "early-turn" })) : scenario === "empty" || scenario === "history" ? [] : scenario === "limit" ? [{ ...files[0], added: null, deleted: null, reason: "storage_limit" }] : scenario === "long" ? [{ ...files[0], path: `${"long-directory/".repeat(40)}source.ts` }] : basePage.files;
const attachments = scenario === "attachments" ? [
  { id: "one", name: "reference.md", media_type: "text/markdown", size: 20, source: "input" },
  { id: "two", name: "reference.md", media_type: "text/markdown", size: 20, source: "input" },
  { id: "html", name: "report.html", media_type: "text/html", size: 40, source: "output" },
  { id: "image", name: "output.png", media_type: "image/png", size: 70, source: "output" },
] : basePage.attachments;
let unavailable = scenario === "read-error";
const requests: string[] = [];
const transport = createFakeTransport(scope, async (_method, path, body) => {
  requests.push(path);
  const url = new URL(path, "http://fixture");
  if (scenario === "paged") summary.turn_count = 100;
  if (url.pathname === "/sessions") return { scope_seq: 1, summaries: [summary], has_more: false };
  if (url.pathname.endsWith("/snapshot")) return { version: 2, store_generation: "fixture", snapshot_seq: 1, conversation: summary, turns: scenario === "paged" ? Array.from({ length: 5 }, (_, i) => ({ id: `recent-${i}`, turn_index: 95+i, request_id: `recent-${i}`, status: "completed", started_at: "2026-11-07T10:00:00Z", completed_at: "2026-11-07T10:00:00Z", messages: [], events: [] })) : [] };
  if (url.pathname.endsWith("/resources")) {
    if (unavailable) throw new Error("transport_offline: fixture unavailable");
    if (scenario === "paged") return { ...basePage, files: url.searchParams.has("cursor") ? resourceFiles.slice(200) : resourceFiles.slice(0, 200), attachments: [], next_cursor: url.searchParams.has("cursor") ? null : "second-page" };
    return { ...basePage, coverage: scenario === "history" ? "missing_baseline" : basePage.coverage, files: resourceFiles, attachments };
  }
  if (url.pathname.includes("/changes/")) { const id = url.pathname.split("/").at(-1)!; return proof ? conversationChangeDetailSchema.parse(proof.details[id]) : { revision: basePage.revision, file: resourceFiles.find(file => file.id === id), ...contents[id] }; }
  if (url.pathname === "/preview/locate") { const path = url.searchParams.get("path")!; return { root: "/project", path, name: path.split("/").at(-1), kind: "file" }; }
  if (url.pathname === "/preview/file") { const path = url.searchParams.get("path")!; return { root: "/project", path, name: path.split("/").at(-1), mime_type: "text/markdown", size: 40 }; }
  if (url.pathname.endsWith("/commands")) return { revision: (body as { workspace?: { revision?: number } })?.workspace?.revision };
  if (url.pathname === "/providers") return { providers: [] };
  throw new Error(`Unexpected fixture request ${path}`);
});
transport.capabilities = async () => scenario === "unsupported" ? [] : [CONVERSATION_RESOURCES_CAPABILITY];
transport.storeGeneration = async () => "fixture";
transport.fileUrl = (_scope, path) => `/__resources/content?path=${encodeURIComponent(path)}`;
Object.defineProperty(window, "__resourceFixture", { value: {
  requests: () => requests.slice(), recover: () => { unavailable = false; },
  detailRevision: () => conversationService(transport, scope).resources("source").model.details.get("redirect")?.revision,
  revise: () => {
    basePage.revision++;
    contents.redirect = scenario === "scroll" ? scrollContents(true) : { before: contents.redirect!.before, after: 'export const redirect = "revision-two";\n', patch: '--- a/src/auth/redirect.ts\n+++ b/src/auth/redirect.ts\n@@ -1 +1 @@\n-export const redirect = (next: string) => next;\n+export const redirect = "revision-two";\n' };
    conversationService(transport, scope).resources("source").invalidate();
  },
  failRefresh: () => { unavailable = true; conversationService(transport, scope).resources("source").invalidate(); },
} });
const device = { id: "local", name: "", transport } as LocalDevice;
Object.defineProperty(window, "desktopAPI", { configurable: true, value: { sideWorkspace: { reconcile: async () => {}, onActivity: () => () => {}, onCommand: () => () => {}, ack: async () => {} }, resourcePreview: (window as unknown as { __resourcePreviewFixture?: unknown }).__resourcePreviewFixture ?? { request: async () => null, subscribe: () => () => {} } } });
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
localStorage.setItem("theme", theme);
const key = `multica-side-workspace:${scope.userId}:${scope.workspaceId}:session:source`;
localStorage.setItem(key, JSON.stringify({ tabs: [{ id: "readme", kind: "file", sourceId: "source", location: { root: "/project", path: "/project/README.md", name: "README.md", kind: "file" } }], selected: "readme", open: true }));
if (scenario === "full") localStorage.setItem(key, JSON.stringify({ tabs: Array.from({ length: 20 }, (_, i) => ({ id: `readme-${i}`, kind: "file", sourceId: "source", location: { root: "/project", path: `/project/README-${i}.md`, name: `README-${i}.md`, kind: "file" } })), selected: "readme-0", open: true }));
if (new URLSearchParams(location.search).has("native")) localStorage.setItem(key, JSON.stringify({ tabs: [{ id: "native-web", kind: "web", sourceId: "source", url: new URL("/__test/native-preview", location.origin).href }], selected: "native-web", open: true }));
const ref = createRef<SideWorkspaceHandle>();
document.body.style.cssText = "margin:0;height:100vh";
createRoot(document.getElementById("root")!).render(<I18nProvider locale="en" resources={RESOURCES}><ThemeProvider forcedTheme={theme}><QueryClientProvider client={new QueryClient()}><LocalDeviceProvider device={device}>
  <div className="flex h-dvh bg-app-shell text-foreground">
    <aside className="hidden w-44 shrink-0 flex-col gap-4 border-r p-4 xl:flex"><b>Multica</b><span>Inbox</span><span>Tasks</span><span className="rounded-md bg-surface-selected p-2">Conversations</span><span>Agents</span></aside>
    <aside className="hidden w-52 shrink-0 border-r p-3 lg:block"><h2 className="mb-6 text-body font-medium">Conversations</h2><div className="rounded-md bg-surface-selected p-3 text-label">Repair login redirect<p className="mt-2 text-caption text-muted-foreground">Codex · Just now</p></div></aside>
    <main className="min-h-0 min-w-0 flex-1"><LocalSideWorkspace ref={ref} scope={scope} slug="fixture" sessionId="source" provider={proofName === "claude" ? "claude" : "codex"} sessions={[]} chinese={false} active onSelectSource={() => {}} onReference={() => {}} onOpenTask={() => {}} onShowMessage={message => { document.body.dataset.error = message; }}>
      {(_visible, resources) => <div className="flex h-full flex-col"><header className="flex h-12 items-center gap-2 border-b px-3 text-body font-medium"><span className="min-w-0 flex-1 truncate">Repair login redirect</span>{resources}<button onClick={() => ref.current?.toggle()} aria-label="Toggle original workspace"><PanelRightOpen className="size-4" /></button></header><div className="flex-1 p-5 text-body"><p className="rounded-xl bg-surface-hover p-3">Keep the original destination after login, and add tests.</p><h3 className="mb-3 mt-6 font-medium">Codex</h3><p>I updated redirect validation and added tests.</p><button className="mt-3 text-brand" onClick={() => ref.current?.openChanges("redirect")}>View changes</button></div><textarea aria-label="Main draft" className="m-4 min-h-24 rounded-xl border bg-surface p-3 text-body" placeholder="Continue the conversation..." /></div>}
    </LocalSideWorkspace></main>
  </div>
</LocalDeviceProvider></QueryClientProvider></ThemeProvider></I18nProvider>);
