import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { Agent, ChatSession } from "@multica/core/types";
import enChat from "../locales/en/chat.json";
import { AgentWorkspaceSessionRow } from "./agent-workspace-session-row";

vi.mock("../common/actor-avatar", () => ({ ActorAvatar: () => null }));

const session: ChatSession = {
  id: "session-1",
  workspace_id: "workspace-1",
  agent_id: "agent-1",
  creator_id: "user-1",
  title: "Project discussion",
  status: "active",
  has_unread: true,
  unread_count: 3,
  last_message: {
    content: "**Project** update\nready",
    role: "assistant",
    created_at: "2026-10-23T10:00:00Z",
  },
  created_at: "2026-10-20T10:00:00Z",
  updated_at: "2026-10-20T10:00:00Z",
};

function renderRow(overrides: Partial<React.ComponentProps<typeof AgentWorkspaceSessionRow>> = {}) {
  const callbacks = { onSelect: vi.fn(), onTogglePin: vi.fn(), onArchive: vi.fn(), onUnarchive: vi.fn() };
  render(
    <I18nProvider locale="en" resources={{ en: { chat: enChat } }}>
      <AgentWorkspaceSessionRow
        session={session}
        agent={{ id: "agent-1", name: "Alpha" } as Agent}
        active={false}
        running={false}
        offline={false}
        actionPending={false}
        {...callbacks}
        {...overrides}
      />
    </I18nProvider>,
  );
  return callbacks;
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: enChat.list.row_actions_aria }), { key: "Enter" });
}

describe("AgentWorkspaceSessionRow", () => {
  it("shows the latest activity, readable message preview, and unread count", () => {
    renderRow();

    expect(screen.getByText("Project update ready")).toBeInTheDocument();
    expect(screen.getByText("3")).toHaveAttribute("aria-label", enChat.workbench.unread);
    expect(document.querySelector("time")).toHaveAttribute("datetime", session.last_message!.created_at);
  });

  it("keeps the active conversation read and supports the old unread flag without a count", () => {
    const { unmount } = render(
      <I18nProvider locale="en" resources={{ en: { chat: enChat } }}>
        <AgentWorkspaceSessionRow session={session} active running={false} offline={false} actionPending={false} onSelect={vi.fn()} onTogglePin={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByLabelText(enChat.workbench.unread)).not.toBeInTheDocument();
    unmount();

    renderRow({ session: { ...session, unread_count: undefined } });
    expect(screen.getByLabelText(enChat.workbench.unread)).toHaveTextContent("1");
  });

  it("reveals menu actions with the keyboard without selecting the conversation", async () => {
    const callbacks = renderRow();

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: enChat.list.pin }));

    expect(callbacks.onTogglePin).toHaveBeenCalledOnce();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(callbacks.onArchive).not.toHaveBeenCalled();
  });

  it("archives from the row menu without changing selection first", async () => {
    const callbacks = renderRow();
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: enChat.list.archive }));

    expect(callbacks.onArchive).toHaveBeenCalledOnce();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("offers unarchive as the only action in the archive view", async () => {
    const callbacks = renderRow({ session: { ...session, status: "archived" } });
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: enChat.list.unarchive }));

    expect(callbacks.onUnarchive).toHaveBeenCalledOnce();
    expect(callbacks.onArchive).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: enChat.list.pin })).not.toBeInTheDocument();
  });

  it("shows waiting for an offline run and prevents archiving an in-flight conversation", async () => {
    renderRow({ running: true, offline: true });
    expect(screen.getByText(enChat.list.waiting)).toBeInTheDocument();
    expect(screen.queryByText("Project update ready")).not.toBeInTheDocument();
    openMenu();

    expect(await screen.findByRole("menuitem", { name: enChat.list.pin })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: enChat.list.archive })).not.toBeInTheDocument();
  });

  it("localizes the failed reply instead of presenting its error body as a normal preview", () => {
    renderRow({ session: { ...session, last_message: { ...session.last_message!, failure_reason: "agent_error" } } });

    expect(screen.getByText(enChat.list.failed)).toBeInTheDocument();
    expect(screen.queryByText("Project update ready")).not.toBeInTheDocument();
  });

  it("falls back to session activity when the message timestamp is malformed", () => {
    renderRow({ session: { ...session, last_message: { ...session.last_message!, created_at: "invalid" } } });

    expect(document.querySelector("time")).toHaveAttribute("datetime", session.updated_at);
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });
});
