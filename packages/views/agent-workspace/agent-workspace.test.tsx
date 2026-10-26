import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { chatKeys } from "@multica/core/chat/queries";
import type { Agent, ChatSession } from "@multica/core/types";
import type { ChatController } from "../chat/components/use-chat-controller";
import enChat from "../locales/en/chat.json";
import enCommon from "../locales/en/common.json";

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({
    agents: () => "/dev/agents",
    newAgent: () => "/dev/agents/new",
    agentDetail: (id: string) => `/dev/agents/${id}`,
    issues: () => "/dev/issues",
  }),
}));
vi.mock("../navigation", () => ({
  AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../layout/page-header", () => ({
  PageHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));
vi.mock("./agent-task-panel", () => ({ AgentTaskPanel: () => null }));
vi.mock("@multica/core/agents", () => ({
  useWorkspacePresenceMap: () => ({ byAgent: new Map(), loading: false }),
}));
vi.mock("@multica/core/chat/mutations", () => ({
  useSetChatSessionArchived: () => ({ mutate: vi.fn(), isPending: false }),
  useSetChatSessionPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AgentWorkspace } from "./agent-workspace";

const alpha = { id: "agent-alpha", name: "Alpha", archived_at: null } as Agent;
const beta = { id: "agent-beta", name: "张三", archived_at: null } as Agent;
const session = (id: string, agent: Agent, overrides: Partial<ChatSession> = {}): ChatSession => ({
  id,
  agent_id: agent.id,
  workspace_id: "workspace-1",
  creator_id: "user-1",
  title: id,
  status: "active",
  has_unread: false,
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
  ...overrides,
});

const current = session("Current discussion", alpha);
const olderPinned = session("Pinned discussion", beta, { pinned: true });
const recent = session("Recent discussion", beta, { updated_at: "2026-10-23T10:00:00Z" });
const archived = session("Archived discussion", beta, { status: "archived" });

function renderWorkspace(overrides: Partial<ChatController> = {}) {
  const onStartChat = vi.fn();
  const onSelectSession = vi.fn();
  const c = {
    wsId: "workspace-1",
    agents: [alpha, beta],
    availableAgents: [alpha, beta],
    sessions: [current, olderPinned, recent, archived],
    activeSessionId: current.id,
    activeAgent: alpha,
    isAgentRuntimeBound: true,
    ...overrides,
  } as ChatController;
  const props = {
    controller: c,
    conversation: <div>Conversation draft</div>,
    onStartChat,
    onSelectSession,
    onArchive: vi.fn(),
    onReference: vi.fn(),
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(chatKeys.pendingTasks(c.wsId), { tasks: [] });
  render(
    <QueryClientProvider client={queryClient}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, common: enCommon } }}>
      <AgentWorkspace {...props} />
    </I18nProvider>
    </QueryClientProvider>,
  );
  return { onStartChat, onSelectSession };
}

function directory() {
  return within(screen.getByRole("navigation", { name: enChat.workbench.agents_sessions }));
}

describe("AgentWorkspace directory interactions", () => {
  it("keeps the current discussion and draft when selecting its agent", () => {
    const { onStartChat, onSelectSession } = renderWorkspace();

    fireEvent.click(directory().getByRole("button", { name: "Alpha" }));

    expect(onStartChat).not.toHaveBeenCalled();
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(directory().getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the other agent's most recent active discussion instead of starting a new draft", () => {
    const { onStartChat, onSelectSession } = renderWorkspace();

    fireEvent.click(directory().getByRole("button", { name: "张三" }));

    expect(onStartChat).not.toHaveBeenCalled();
    expect(onSelectSession).toHaveBeenCalledWith(recent);
    expect(directory().queryByText(current.title)).not.toBeInTheDocument();
    expect(directory().getByText(recent.title)).toBeInTheDocument();
  });

  it("starts a draft for a selected agent only when it has no active history", () => {
    const { onStartChat, onSelectSession } = renderWorkspace({ sessions: [current, archived] });

    fireEvent.click(directory().getByRole("button", { name: "张三" }));

    expect(onStartChat).toHaveBeenCalledWith(beta);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("allows reading an unavailable agent's history while blocking a new conversation", () => {
    const { onStartChat, onSelectSession } = renderWorkspace({ availableAgents: [alpha] });
    fireEvent.click(directory().getByRole("button", { name: /张三\s*Unavailable/ }));

    expect(onSelectSession).toHaveBeenCalledWith(recent);
    expect(onStartChat).not.toHaveBeenCalled();
  });

  it("disables an unavailable agent with no readable history", () => {
    renderWorkspace({ availableAgents: [alpha], sessions: [current] });

    expect(directory().getByRole("button", { name: /张三\s*Unavailable/ })).toBeDisabled();
  });

  it("preserves search text when filtering by an agent", () => {
    renderWorkspace();
    const search = directory().getByRole("textbox", { name: enChat.workbench.search });
    fireEvent.change(search, { target: { value: "Alpha" } });

    fireEvent.click(directory().getByRole("button", { name: "Alpha" }));

    expect(search).toHaveValue("Alpha");
    expect(directory().getByText(current.title)).toBeInTheDocument();
  });

  it("matches session agent names and the existing pinyin search convention", () => {
    renderWorkspace();
    fireEvent.change(directory().getByRole("textbox", { name: enChat.workbench.search }), {
      target: { value: "zhang" },
    });

    expect(directory().getByRole("button", { name: "张三" })).toBeInTheDocument();
    expect(directory().getByText(recent.title)).toBeInTheDocument();
    expect(directory().queryByText(current.title)).not.toBeInTheDocument();
  });

  it("starts a fresh conversation only through the explicit new conversation action and exits archive", () => {
    const { onStartChat } = renderWorkspace();
    fireEvent.click(directory().getByRole("button", { name: enChat.workbench.archived }));
    expect(directory().getByText(archived.title)).toBeInTheDocument();

    fireEvent.click(directory().getByRole("button", { name: enChat.workbench.new_session }));

    expect(onStartChat).toHaveBeenCalledWith(alpha);
    expect(directory().queryByText(archived.title)).not.toBeInTheDocument();
    expect(directory().getByText(current.title)).toBeInTheDocument();
  });
});
