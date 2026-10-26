import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { Agent, ChatSession } from "@multica/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";

// --- Mocks ------------------------------------------------------------------
// The list no longer owns the archive-advance behavior — the parent (ChatPage)
// does, so it stays layout-aware and routes through the shared controller. Here
// we only assert the history-row Archive action delegates to the `onArchive`
// prop and does NOT fire the archive mutation itself. The advance semantics
// (next / previous / clear / cross-agent sync) are covered in the controller
// test, and mobile-vs-desktop in the page. setActiveSession/archiveMutate are
// kept as negative assertions: the list must not touch them for a history
// archive anymore.

const setActiveSession = vi.fn();
const archiveMutate = vi.fn();
const deleteMutate = vi.fn();

afterEach(() => vi.restoreAllMocks());

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid={`avatar-${actorId}`} />
  ),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multica/core/paths")>(),
  useWorkspaceSlug: () => "acme",
}));

vi.mock("@multica/core/agents", () => ({
  useWorkspacePresenceMap: () => ({ byAgent: new Map() }),
}));

vi.mock("@multica/core/api", () => ({
  api: { cancelTaskById: vi.fn() },
}));

vi.mock("@multica/core/chat", () => ({
  useChatStore: (selector: (s: { setActiveSession: typeof setActiveSession }) => unknown) =>
    selector({ setActiveSession }),
}));

vi.mock("@multica/core/chat/mutations", () => ({
  useDeleteChatSession: () => ({ mutate: deleteMutate, isPending: false }),
  useSetChatSessionPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetChatSessionArchived: () => ({ mutate: archiveMutate, isPending: false }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => ({ data: { tasks: [] } }),
    useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
  };
});

import { ChatThreadList } from "./chat-thread-list";

const TEST_RESOURCES = { en: { chat: enChat, issues: enIssues } };

function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id">): ChatSession {
  return {
    workspace_id: "ws-1",
    agent_id: "agent-1",
    creator_id: "user-1",
    title: `Chat ${overrides.id}`,
    status: "active",
    has_unread: false,
    unread_count: 0,
    last_message: null,
    pinned: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

const agent = { id: "agent-1", name: "Alpha" } as unknown as Agent;

// Sessions are sorted by most-recent activity (updated_at) first, pinned first.
// Give them descending timestamps so the rendered order is s1, s2, s3.
const sessions: ChatSession[] = [
  makeSession({ id: "s1", updated_at: "2026-07-08T03:00:00Z" }),
  makeSession({ id: "s2", updated_at: "2026-07-08T02:00:00Z" }),
  makeSession({ id: "s3", updated_at: "2026-07-08T01:00:00Z" }),
];

function renderList(
  activeSessionId: string | null,
  {
    onArchive = vi.fn(),
    onSelectSession = vi.fn(),
    renderedSessions = sessions,
    renderedAgents = [agent],
    onDeletedSession,
    getSessionHref,
    navigation,
  }: {
    onArchive?: (session: ChatSession) => void;
    onSelectSession?: (session: ChatSession) => void;
    renderedSessions?: ChatSession[];
    renderedAgents?: Agent[];
    onDeletedSession?: (sessionId: string) => void;
    getSessionHref?: (sessionId: string) => string | null;
    navigation?: NavigationAdapter;
  } = {},
) {
  const content = (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ChatThreadList
        sessions={renderedSessions}
        agents={renderedAgents}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onArchive={onArchive}
        onDeletedSession={onDeletedSession}
        getSessionHref={getSessionHref}
      />
    </I18nProvider>
  );
  render(navigation ? <NavigationProvider value={navigation}>{content}</NavigationProvider> : content);
  return { onArchive, onSelectSession };
}

const ARCHIVE_LABEL = enChat.list.archive;

describe("conversation search", () => {
  it("matches title, Agent and authored preview while keeping the archive view through an empty search", () => {
    const chats = [
      makeSession({ id: "current", title: "Design review" }),
      makeSession({ id: "archive", title: "Saved report", status: "archived", last_message: { role: "assistant", content: "Ready for acceptance", created_at: "2026-07-08T00:00:00Z" } }),
    ];
    const onSelect = vi.fn();
    const content = (searchQuery: string) => <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ChatThreadList sessions={chats} agents={[agent]} activeSessionId="current" onArchive={vi.fn()} onSelectSession={onSelect}
        searchQuery={searchQuery} emptyContent={<p>No matches</p>} />
    </I18nProvider>;
    const view = render(content("design"));
    expect(screen.getByText("Design review")).toBeVisible();
    view.rerender(content("ALPHA"));
    expect(screen.getByText("Design review")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    view.rerender(content("acceptance"));
    expect(screen.getByText("Saved report")).toBeVisible();
    view.rerender(content("missing"));
    expect(screen.getByText("No matches")).toBeVisible();
    view.rerender(content(""));
    expect(screen.getByText("Saved report")).toBeVisible();
    expect(screen.queryByText("Design review")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("ChatThreadList archive delegation", () => {
  beforeEach(() => {
    setActiveSession.mockClear();
    archiveMutate.mockClear();
  });

  it("delegates the history-row Archive action to onArchive with that session", () => {
    const { onArchive } = renderList("s2");
    // Rows render in order s1, s2, s3 → the second archive button is s2's.
    const archiveButtons = screen.getAllByRole("button", { name: ARCHIVE_LABEL });
    fireEvent.click(archiveButtons[1]!);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
  });

  it("passes the archived row's session even when it isn't the open one", () => {
    const { onArchive } = renderList("s1");
    const archiveButtons = screen.getAllByRole("button", { name: ARCHIVE_LABEL });
    // Archive s3 while s1 is the open one — the parent decides what to do.
    fireEvent.click(archiveButtons[2]!);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: "s3" }));
  });

  it("does not flip archive status or move selection itself", () => {
    renderList("s2");
    const archiveButtons = screen.getAllByRole("button", { name: ARCHIVE_LABEL });
    fireEvent.click(archiveButtons[1]!);

    // Advance + mutation are the parent/controller's job now; the list stays out.
    expect(setActiveSession).not.toHaveBeenCalled();
    expect(archiveMutate).not.toHaveBeenCalled();
  });
});

describe("ChatThreadList deletion ownership", () => {
  beforeEach(() => {
    deleteMutate.mockReset();
    setActiveSession.mockReset();
  });

  function confirmDeletion(options: Parameters<typeof renderList>[1] = {}) {
    renderList("archived-1", {
      ...options,
      renderedSessions: [makeSession({ id: "archived-1", status: "archived" })],
    });
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    fireEvent.click(screen.getByRole("button", { name: enChat.session_history.row_delete_aria }));
    fireEvent.click(screen.getByRole("button", { name: enChat.session_history.delete_dialog.confirm }));
    return deleteMutate.mock.calls[0]![1] as {
      onSuccess?: () => void;
      onSettled: () => void;
    };
  }

  it("delegates successful deletion without changing Chat selection", () => {
    const onDeletedSession = vi.fn();
    const callbacks = confirmDeletion({ onDeletedSession });

    expect(deleteMutate).toHaveBeenCalledWith("archived-1", expect.any(Object));
    expect(onDeletedSession).not.toHaveBeenCalled();
    expect(setActiveSession).not.toHaveBeenCalled();

    act(() => callbacks.onSuccess?.());

    expect(onDeletedSession).toHaveBeenCalledExactlyOnceWith("archived-1");
    expect(setActiveSession).not.toHaveBeenCalled();
  });

  it("does not notify deletion when the mutation settles after failure", () => {
    const onDeletedSession = vi.fn();
    const callbacks = confirmDeletion({ onDeletedSession });

    act(() => callbacks.onSettled());

    expect(onDeletedSession).not.toHaveBeenCalled();
    expect(setActiveSession).not.toHaveBeenCalled();
  });

  it("keeps the default Chat selection cleanup before deleting", () => {
    confirmDeletion();

    expect(setActiveSession).toHaveBeenCalledExactlyOnceWith(null);
    expect(setActiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMutate.mock.invocationCallOrder[0]!,
    );
  });
});

describe("ChatThreadList session destinations", () => {
  const navigation = (): NavigationAdapter => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/conversations",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `https://app.test${path}`,
  });

  it.each(["modifier", "middle"])("uses a custom destination for %s clicks", (intent) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const getSessionHref = vi.fn((id: string) => `/acme/conversations?session=${id}`);
    const onSelectSession = vi.fn();
    renderList(null, { getSessionHref, navigation: navigation(), onSelectSession });
    const row = screen.getByText("Chat s2").closest("[tabindex]")!;

    if (intent === "modifier") fireEvent.click(row, { metaKey: true });
    else fireEvent(row, new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(getSessionHref).toHaveBeenCalledWith("s2");
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://app.test/acme/conversations?session=s2", "_blank", "noopener,noreferrer",
    );
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("keeps the Chat destination when no override is supplied", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderList(null, { navigation: navigation() });

    fireEvent.click(screen.getByText("Chat s1").closest("[tabindex]")!, { metaKey: true });

    expect(open).toHaveBeenCalledWith(
      "https://app.test/acme/chat?session=s1", "_blank", "noopener,noreferrer",
    );
  });
});

describe("ChatThreadList no_response preview (MUL-4351)", () => {
  it("shows a localized 'no text reply' preview instead of the fallback body", () => {
    const session = makeSession({
      id: "nr1",
      last_message: {
        content: "The agent finished this turn without a text reply.",
        role: "assistant",
        created_at: "2026-07-08T03:00:00Z",
        message_kind: "no_response",
      },
    });
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatThreadList
          sessions={[session]}
          agents={[agent]}
          activeSessionId={null}
          onSelectSession={vi.fn()}
          onArchive={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByText(enChat.list.no_response_preview)).toBeInTheDocument();
    // The stored English fallback body must not leak into the preview.
    expect(
      screen.queryByText("The agent finished this turn without a text reply."),
    ).not.toBeInTheDocument();
  });
});

describe("ChatThreadList agent identity", () => {
  it("shows and bounds the resolved agent name without replacing the preview", () => {
    const longName = "A very long agent name that must not take over the conversation row";
    const longNameAgent = { id: "agent-1", name: longName } as unknown as Agent;
    const session = makeSession({
      id: "agent-name",
      last_message: {
        content: "Latest project update",
        role: "assistant",
        created_at: "2026-07-08T03:00:00Z",
      },
    });

    renderList(null, {
      renderedSessions: [session],
      renderedAgents: [longNameAgent],
    });

    const name = screen.getByText(longName);
    expect(name.className).toContain("max-w-[40%]");
    expect(name.className).toContain("truncate");
    expect(screen.getByText("Latest project update")).toBeInTheDocument();
  });

  it("keeps the existing preview when the session agent is unavailable", () => {
    const session = makeSession({
      id: "missing-agent",
      agent_id: "missing-agent-id",
      last_message: {
        content: "Still identifiable by its preview",
        role: "assistant",
        created_at: "2026-07-08T03:00:00Z",
      },
    });

    renderList(null, { renderedSessions: [session] });

    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Still identifiable by its preview")).toBeInTheDocument();
  });
});

// Touch has no hover, so the hover strip's actions also live in a per-row menu.
describe("ChatThreadList compact row menu", () => {
  beforeEach(() => {
    setActiveSession.mockClear();
    archiveMutate.mockClear();
  });

  const openRowMenu = (index: number) =>
    fireEvent.click(
      screen.getAllByRole("button", { name: enChat.list.row_actions_aria })[index]!,
    );

  it("archives the row it belongs to", async () => {
    const { onArchive } = renderList("s1");

    openRowMenu(1);
    fireEvent.click(await screen.findByRole("menuitem", { name: ARCHIVE_LABEL }));

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
  });

  it("offers the same pin toggle the hover strip does", async () => {
    renderList(null);

    openRowMenu(0);

    expect(await screen.findByRole("menuitem", { name: enChat.list.pin })).toBeInTheDocument();
  });

  it("does not select the row when the menu opens", () => {
    const { onSelectSession } = renderList(null);

    openRowMenu(0);

    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("stays reachable on a wide viewport that cannot hover", () => {
    // The menu and the hover strip must both switch on hover capability. Gating
    // either on width strands a landscape phone: past `md` the menu would be
    // hidden and the strip would wait for a hover that never arrives.
    renderList(null);

    const trigger = screen.getAllByRole("button", {
      name: enChat.list.row_actions_aria,
    })[0]!;
    const strip = trigger.parentElement!.querySelector(
      "[class*='group-hover/row']",
    )!;

    expect(trigger.className).toContain("[@media(hover:hover)]:hidden");
    expect(trigger.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):hidden/);
    expect(strip.className).toContain("[@media(hover:hover)]:group-hover/row:flex");
    expect(strip.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):group-/);
  });
});

describe("ChatThreadList row keyboard semantics", () => {
  it("selects the row on Enter", () => {
    const { onSelectSession } = renderList(null);

    const row = screen.getByText("Chat s1").closest("[tabindex]")!;
    fireEvent.keyDown(row, { key: "Enter" });

    expect(onSelectSession).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter pressed inside a row control to that control", () => {
    // Opening the action menu with the keyboard must not also select the row.
    const { onSelectSession } = renderList(null);

    fireEvent.keyDown(
      screen.getAllByRole("button", { name: enChat.list.row_actions_aria })[0]!,
      { key: "Enter" },
    );

    expect(onSelectSession).not.toHaveBeenCalled();
  });
});
