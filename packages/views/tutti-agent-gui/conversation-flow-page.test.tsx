import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paths } from "@multica/core/paths";
import { ConversationFlowPage } from "./conversation-flow-page";
import type { TuttiAgentGuiPanel } from "./tutti-agent-gui-panel";

const state = vi.hoisted(() => ({
  pathname: "/acme/conversations", search: "session=flow-session", slug: "acme",
  replace: vi.fn(), push: vi.fn(), openInNewTab: vi.fn(), panel: vi.fn(), restore: vi.fn(), nativeChat: vi.fn(),
  create: vi.fn(), archive: vi.fn(), read: vi.fn(), list: vi.fn(), compact: false,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: { queryKey: string[] }) => ({
  data: queryKey.includes("chat") ? [{ id: "flow-session", title: "Saved design review", agent_id: "codex", status: "active", has_unread: true, updated_at: "2026-10-23T00:00:00Z" }, { id: "next-session", title: "Other conversation", agent_id: "codex", status: "active", last_message: { content: "Ready for acceptance", role: "assistant" } }]
    : queryKey.includes("agents") ? [{ id: "codex", name: "Codex", runtime_id: "runtime" }]
      : [{ user_id: "user", role: "member" }], isSuccess: true,
}) }));
vi.mock("@multica/core/chat/queries", () => ({ chatSessionsOptions: () => ({ queryKey: ["chat"] }), sortChatSessions: (sessions: unknown[]) => sessions }));
vi.mock("@multica/core/workspace/queries", () => ({ agentListOptions: () => ({ queryKey: ["agents"] }), memberListOptions: () => ({ queryKey: ["members"] }) }));
vi.mock("@multica/core/chat/mutations", () => ({ useCreateChatSession: () => ({ mutate: state.create }), useSetChatSessionArchived: () => ({ mutate: state.archive }), useMarkChatSessionRead: () => ({ mutate: state.read }) }));
vi.mock("@multica/core/agents", () => ({ isAgentRuntimeBound: () => true }));
vi.mock("@multica/core/permissions", () => ({ canAssignAgentToIssue: () => ({ allowed: true }) }));
vi.mock("@multica/ui/hooks/use-mobile", () => ({ useIsCompact: () => state.compact }));
vi.mock("../layout/page-header", () => ({ PageHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
vi.mock("../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../chat/components/chat-session-header", () => ({ ChatSessionHeader: ({ leading }: { leading?: React.ReactNode }) => <header>{leading}Session header</header> }));
vi.mock("../chat/components/chat-thread-list", () => ({ ChatThreadList: (props: unknown) => { state.list(props); return <div>Session list</div>; } }));
vi.mock("../i18n", () => ({ useT: () => ({ t: (select: (value: unknown) => string) => select({ workbench: { sessions: "Sessions", conversation: "Conversation", new_session: "New conversation", session_action_error: "Failed", search_sessions: "Search conversations", clear_search: "Clear search", no_search_results: "No matching conversations", return_conversation: "Return to conversation" } }) }) }));
vi.mock("@multica/core/paths", async (original) => ({
  ...await original<typeof import("@multica/core/paths")>(),
  useRequiredWorkspaceSlug: () => "acme", useCurrentWorkspace: () => ({ id: "ws", slug: "acme" }),
  useWorkspacePaths: () => paths.workspace("acme"),
}));
vi.mock("@multica/core/auth", () => ({ useAuthStore: (select: (value: unknown) => unknown) => select({ user: { id: "user" } }) }));
vi.mock("@multica/core/platform", () => ({ getCurrentSlug: () => state.slug }));
vi.mock("@multica/core/chat", () => ({ useChatStore: state.nativeChat }));
vi.mock("../common/use-app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../chat/components/use-chat-draft-restore", () => ({ useChatDraftRestore: state.restore }));
vi.mock("../navigation", () => ({ useNavigation: () => ({
  pathname: state.pathname, searchParams: new URLSearchParams(state.search),
  replace: state.replace, push: state.push, openInNewTab: state.openInNewTab,
}) }));
vi.mock("./tutti-agent-gui-panel", () => ({ TuttiAgentGuiPanel: (props: ComponentProps<typeof TuttiAgentGuiPanel>) => {
  state.panel(props);
  return <>
    <button onClick={() => props.onSelectSession({ id: "next-session" } as never)}>Select conversation</button>
    <button onClick={() => props.onSelectSession(null, { id: "codex" } as never)}>Switch Agent</button>
    <button onClick={() => props.onOpenTask("issue-1")}>Open task</button>
  </>;
} }));

beforeEach(() => {
  vi.clearAllMocks();
  state.pathname = "/acme/conversations"; state.search = "session=flow-session"; state.slug = "acme";
  state.compact = false;
  state.restore.mockReturnValue({ restoreDraftRequest: null, handleRestoreDraftApplied: vi.fn() });
});
afterEach(cleanup);

describe("independent conversation flow", () => {
  it("uses its own URL selection and never changes the native Chat pointer", () => {
    render(<ConversationFlowPage />);
    expect(state.panel).toHaveBeenCalledWith(expect.objectContaining({ activeSessionId: "flow-session", active: true }));
    fireEvent.click(screen.getByText("Select conversation"));
    expect(state.replace).toHaveBeenLastCalledWith("/acme/conversations?session=next-session");
    fireEvent.click(screen.getByText("Switch Agent"));
    expect(state.replace).toHaveBeenLastCalledWith("/acme/conversations?agent=codex");
    expect(state.nativeChat).not.toHaveBeenCalled();
    expect(state.read).toHaveBeenCalledWith("flow-session");
  });

  it("opens tasks separately and leaves the conversation tab on its current URL", () => {
    render(<ConversationFlowPage />);
    fireEvent.click(screen.getByText("Open task"));
    expect(state.openInNewTab).toHaveBeenCalledWith("/acme/issues/issue-1", undefined, { activate: true });
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("routes list links and successful archives within Conversations", () => {
    render(<ConversationFlowPage />);
    const list = state.list.mock.lastCall?.[0];
    expect(list.getSessionHref("next-session")).toBe("/acme/conversations?session=next-session");
    list.onArchive({ id: "flow-session" });
    expect(state.replace).not.toHaveBeenCalled();
    state.archive.mock.lastCall?.[1].onSuccess();
    expect(state.replace).toHaveBeenLastCalledWith("/acme/conversations?session=next-session");
    expect(state.nativeChat).not.toHaveBeenCalled();
  });

  it("creates an empty session with the current Agent from the list header", () => {
    render(<ConversationFlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(state.create).toHaveBeenCalledWith({ agent_id: "codex" }, expect.any(Object));
    act(() => state.create.mock.lastCall?.[1].onSuccess({ id: "created", agent_id: "codex" }));
    expect(state.replace).toHaveBeenLastCalledWith("/acme/conversations?session=created");
    expect(state.nativeChat).not.toHaveBeenCalled();
  });

  it("does not let a late create response replace a newer session selection", () => {
    render(<ConversationFlowPage />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const complete = state.create.mock.lastCall?.[1].onSuccess;
    fireEvent.click(screen.getByText("Select conversation"));
    complete({ id: "created", agent_id: "codex" });
    expect(state.replace).toHaveBeenCalledTimes(1);
    expect(state.replace).toHaveBeenLastCalledWith("/acme/conversations?session=next-session");
  });

  it("reveals a newly created conversation and requests input focus only after success", () => {
    render(<ConversationFlowPage />);
    const input = screen.getByRole("textbox", { name: "Search conversations" });
    fireEvent.change(input, { target: { value: "Saved design" } });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(input).toHaveValue("Saved design");
    expect(state.panel.mock.lastCall?.[0].composerFocusSequence).toBeUndefined();
    act(() => state.create.mock.lastCall?.[1].onSuccess({ id: "created", agent_id: "codex" }));
    expect(input).toHaveValue("");
    expect(state.panel.mock.lastCall?.[0].composerFocusSequence).toBe(1);
    expect(state.replace).toHaveBeenLastCalledWith("/acme/conversations?session=created");
  });

  it("preserves search and focus intent when a late create is superseded", () => {
    render(<ConversationFlowPage />);
    const input = screen.getByRole("textbox", { name: "Search conversations" });
    fireEvent.change(input, { target: { value: "Saved design" } });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    const complete = state.create.mock.lastCall?.[1].onSuccess;
    fireEvent.click(screen.getByText("Select conversation"));
    act(() => complete({ id: "late-created", agent_id: "codex" }));
    expect(input).toHaveValue("Saved design");
    expect(state.panel.mock.lastCall?.[0].composerFocusSequence).toBeUndefined();
  });

  it("keeps the conversation document mounted when compact list navigation changes", () => {
    state.compact = true;
    const view = render(<ConversationFlowPage />);
    const detail = screen.getByTestId("conversation-flow-detail");
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(detail.parentElement).toHaveAttribute("hidden");
    expect(state.panel).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    state.compact = false;
    view.rerender(<ConversationFlowPage />);
    expect(screen.getByTestId("conversation-flow-detail")).toBe(detail);
    expect(detail.parentElement).not.toHaveAttribute("hidden");
    expect(state.panel).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
  });

  it("keeps selection and the conversation mounted while searching, and Escape clears search", () => {
    render(<ConversationFlowPage />);
    const input = screen.getByRole("textbox", { name: "Search conversations" });
    const detail = screen.getByTestId("conversation-flow-detail");
    fireEvent.change(input, { target: { value: "design" } });
    expect(state.list.mock.lastCall?.[0].searchQuery).toBe("design");
    fireEvent.change(input, { target: { value: "acceptance" } });
    expect(state.list.mock.lastCall?.[0].searchQuery).toBe("acceptance");
    fireEvent.change(input, { target: { value: "No such session" } });
    expect(state.list.mock.lastCall?.[0].emptyContent).toBeDefined();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(state.list.mock.lastCall?.[0].sessions).toHaveLength(2);
    expect(state.list.mock.lastCall?.[0].searchQuery).toBe("");
    expect(screen.getByTestId("conversation-flow-detail")).toBe(detail);
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("returns from a compact search with no results to the same mounted conversation", () => {
    state.compact = true;
    render(<ConversationFlowPage />);
    const detail = screen.getByTestId("conversation-flow-detail");
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), { target: { value: "No matches" } });
    fireEvent.click(screen.getByRole("button", { name: "Return to conversation" }));
    expect(detail.parentElement).not.toHaveAttribute("hidden");
    expect(state.panel).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("does not let a retained view change the next workspace or consume its restores", () => {
    state.slug = "globex"; state.pathname = "/globex/chat";
    render(<ConversationFlowPage />);
    expect(state.panel).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(state.restore).toHaveBeenCalledWith("flow-session", false);
    expect(state.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Select conversation"));
    expect(state.replace).not.toHaveBeenCalled();
  });
});
