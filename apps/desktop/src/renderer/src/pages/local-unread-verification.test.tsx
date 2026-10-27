import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalConversationService } from "../../../main/local-conversation-service";
import { LocalConversationFlowPage } from "./local-conversation-flow";

const mock = vi.hoisted(() => ({ selected: "" }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: Object.assign((selector: (state: unknown) => unknown) => selector({ user: { id: "user" } }), { getState: () => ({ user: { id: "user" } }) }) }));
vi.mock("@multica/core/paths", () => ({ useCurrentWorkspace: () => ({ id: "workspace" }), useRequiredWorkspaceSlug: () => "test", useWorkspacePaths: () => ({ conversationFlow: () => "/test/conversations" }) }));
vi.mock("@multica/core/platform", () => ({ getCurrentSlug: () => "test", getCurrentWsId: () => "workspace" }));
vi.mock("@multica/core/projects/queries", () => ({ projectListOptions: () => ({ queryKey: ["test-projects"], queryFn: async () => [] }) }));
vi.mock("@multica/views/navigation", () => ({
  useNavigation: () => ({ pathname: "/test/conversations", searchParams: new URLSearchParams({ session: mock.selected }), replace: vi.fn() }),
  useAppOrigin: () => window.location.origin, useOptionalNavigation: () => null,
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@multica/views/i18n", () => ({ useLocale: () => "zh-Hans", useT: () => ({ t: (select: (value: unknown) => string) => select({ workbench: { title: "Real Agent GUI", loading: "Loading GUI", load_error: "GUI failed", retry: "Retry" } }) }) }));
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsCompact: () => false }));
vi.mock("@multica/core/realtime", () => ({ useWSReconnect: () => {} }));
vi.mock("@multica/ui/components/common/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../platform/local-conversation-service", () => ({
  localConversationKey: () => ["test-local-sessions"], localTargetId: (provider: string) => `local:${provider}`,
  createLocalConversationParentService: () => ({ load: () => new Promise(() => {}), subscribe: () => () => {}, reconnect: () => {}, dispose: () => {}, publish: () => {} }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("local unread persistence while the real GUI panel is still loading", () => {
  it.each(["codex", "claude"] as const)("preserves the unseen %s reply across restart", async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "local-unread-render-"));
    const scope = { userId: "user", workspaceId: "workspace" };
    const options = { root, apiUrl: "https://example.test", notify: () => {}, chooseDirectory: async () => null,
      find: async () => "/test-owned/fake-cli", run: async () => ({ output: "Reply", sessionId: "fake" }) };
    const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
    let reopened: LocalConversationService | undefined;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    try {
      const entry = await service.request(scope, "create", { provider, title: "Original" });
      const started = await service.request(scope, "remoteBegin", { id: entry.id, content: "Question", agents: [{ id: "fixture", name: "Fixture" }] });
      await service.request(scope, "remoteUpdate", { id: entry.id, turnId: started.turns[0]!.id, output: "UNSEEN_REPLY", status: "completed" });
      const request = vi.spyOn(service, "request");
      mock.selected = entry.id;
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
      Object.defineProperty(window, "desktopAPI", { configurable: true, value: { localConversations: {
        request: request.bind(service), subscribe: () => () => {},
      } } });
      render(<QueryClientProvider client={qc}><LocalConversationFlowPage /></QueryClientProvider>);
      await screen.findByText("Loading GUI");
      await waitFor(() => expect(screen.getByRole("link", { name: /Original/ })).toHaveAttribute("aria-current", "true"));
      expect(request.mock.calls.some(([, method]) => method === "markRead")).toBe(false);
      cleanup(); await service.stop();
      reopened = new LocalConversationService(options); reopened.setCurrentUser(scope.userId);
      expect((await reopened.request(scope, "list", {}))[0]?.hasUnread).toBe(true);
    } finally {
      cleanup(); qc.clear(); await service.stop(); await reopened?.stop(); await rm(root, { recursive: true, force: true });
    }
  });
});
