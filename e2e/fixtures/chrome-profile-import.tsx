import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebResourcePreview } from "../../apps/desktop/src/renderer/src/pages/local-resource-preview";
import type { ResourcePreviewClient } from "../../apps/desktop/src/shared/resource-preview";
import "../../apps/desktop/src/renderer/src/globals.css";

const client: ResourcePreviewClient = {
  request: async (_scope, command) => {
    document.body.dataset.previewAction = command.action;
    return command.action === "show" ? { id: command.id, url: "https://example.test", title: "Fixture", loading: false, canGoBack: false, canGoForward: false } : null;
  },
  subscribe: () => () => {},
  listChromeProfiles: async () => ({ status: "available", profiles: [
    { id: "personal", name: "Personal", email: "personal@example.test" },
    { id: "work", name: "Work profile with a long display name for overflow verification", email: "work-profile-long-email@example.test" },
  ] }),
  importChromeProfile: async (scope, input) => {
    document.body.dataset.chromeImport = JSON.stringify({ scope, input });
    return { status: "partial", imported: 7, skipped: 2, failed: 1 };
  },
  cancelChromeProfileImport: async () => true,
};
Object.defineProperty(window, "desktopAPI", { configurable: true, value: { resourcePreview: client, openExternal: async () => {} } });
const scope = { userId: "fixture-user", workspaceId: "fixture-workspace" };
const chinese = new URLSearchParams(location.search).has("zh");
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}>
  <div className="flex h-dvh justify-end bg-background text-foreground"><div className="h-full w-full max-w-xl border-l border-surface-border">
    <WebResourcePreview scope={scope} id="fixture-web" url="https://example.test" active chinese={chinese} onChange={() => {}} onReference={() => {}} />
  </div></div>
</QueryClientProvider>);
