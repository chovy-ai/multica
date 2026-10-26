import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LocalSideWorkspace, type SideWorkspaceHandle } from "../../apps/desktop/src/renderer/src/pages/local-side-workspace";
import "../../apps/desktop/src/renderer/src/globals.css";

const scope = { userId: "layout-test", workspaceId: "layout-workspace" };
const ref = createRef<SideWorkspaceHandle>();
Object.defineProperty(window, "desktopAPI", { value: {
  localConversations: { request: async (_scope: unknown, method: string, params: { path?: string }) => method === "read" ? { id: "source", cwd: "/project" } : { name: params.path?.split("/").at(-1), path: params.path, mimeType: params.path?.endsWith(".html") ? "text/html" : "text/plain", text: params.path?.endsWith(".html") ? "<h1>Case review</h1><p>Local report preview</p>" : "preview text", size: 12, truncated: false } },
  resourcePreview: { request: async () => null, subscribe: () => () => {} },
}, configurable: true });
document.documentElement.style.height = "100%";
document.body.style.cssText = "height:100%;margin:0";
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}>
  <div className="flex h-dvh flex-col">
    <div className="flex shrink-0 gap-2 p-2"><button onClick={() => ref.current?.toggle()}>Toggle workspace</button>{[1, 2, 3, 4, 5].map((index) => <button key={index} onClick={() => { void ref.current?.openResource("source", `/project/long-preview-file-${index}.ts`); }}>Open file {index}</button>)}<button onClick={() => { void ref.current?.openResource("source", "file:///project/output/cases.html"); }}>Open HTML report</button></div>
    <div className="min-h-0 flex-1"><LocalSideWorkspace ref={ref} scope={scope} slug="test" provider="codex" sessions={[]} chinese={false} active onSelectSource={() => {}} onOpenTask={() => {}} onReference={() => {}} onShowMessage={(message) => { document.body.dataset.error = message; }}>{() => <div className="flex h-full flex-col"><span>Main transcript</span><textarea aria-label="Main draft" className="mt-auto h-20" /></div>}</LocalSideWorkspace></div>
  </div>
</QueryClientProvider>);
