import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { ChatSession } from "@multica/core/types";
import enChat from "../../locales/en/chat.json";
import enCommon from "../../locales/en/common.json";

const { updateMutate, deleteMutate, setActiveSession } = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  deleteMutate: vi.fn(),
  setActiveSession: vi.fn(),
}));

vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ agentDetail: (id: string) => `/agents/${id}` }),
}));

vi.mock("@multica/core/chat/mutations", () => ({
  useUpdateChatSession: () => ({ mutate: updateMutate }),
  useDeleteChatSession: () => ({ mutate: deleteMutate }),
  useSetChatSessionArchived: () => ({ mutate: vi.fn() }),
}));

vi.mock("@multica/core/chat", () => ({
  useChatStore: (selector: (state: { setActiveSession: () => void }) => unknown) =>
    selector({ setActiveSession }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

vi.mock("../../navigation", () => ({
  AppLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { ChatSessionHeader } from "./chat-session-header";

const TEST_RESOURCES = { en: { chat: enChat, common: enCommon } };
const RENAME_LABEL = enChat.header.rename;
const OUTSIDE_LABEL = "Outside control";

const session: ChatSession = {
  id: "session-1",
  workspace_id: "ws-1",
  agent_id: "agent-1",
  creator_id: "user-1",
  title: "Original title",
  status: "active",
  has_unread: false,
  unread_count: 0,
  last_message: null,
  pinned: false,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

function startRename(): HTMLInputElement {
  render(
    <>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatSessionHeader session={session} agent={null} />
      </I18nProvider>
      <button type="button">{OUTSIDE_LABEL}</button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Original title" }));
  return screen.getByRole("textbox", { name: RENAME_LABEL });
}

describe("ChatSessionHeader rename keyboard behavior", () => {
  beforeEach(() => {
    updateMutate.mockReset();
  });

  it.each([
    ["standard composition signal", { isComposing: true, keyCode: 13 }],
    ["Safari composition signal", { isComposing: false, keyCode: 229 }],
  ])("keeps editing when Enter carries the %s", (_name, eventInit) => {
    const input = startRename();
    fireEvent.change(input, { target: { value: "yanjiu" } });

    fireEvent.keyDown(input, { key: "Enter", ...eventInit });

    expect(updateMutate).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("yanjiu");
  });

  it("submits once on a normal Enter", () => {
    const input = startRename();
    fireEvent.change(input, { target: { value: "Renamed chat" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 13 });

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      title: "Renamed chat",
    });
    expect(screen.queryByRole("textbox", { name: RENAME_LABEL })).not.toBeInTheDocument();
  });

  it("defers blur submission until an active composition ends", () => {
    const input = startRename();
    const outside = screen.getByRole("button", { name: OUTSIDE_LABEL });
    fireEvent.change(input, { target: { value: "yanjiu" } });
    fireEvent.compositionStart(input);

    act(() => {
      outside.focus();
    });

    expect(updateMutate).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
    expect(outside).toHaveFocus();

    fireEvent.change(input, { target: { value: "研究" } });
    fireEvent.compositionEnd(input);

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      title: "研究",
    });
    expect(screen.queryByRole("textbox", { name: RENAME_LABEL })).not.toBeInTheDocument();
  });

  it("closes without saving a partial value when compositionend does not arrive", async () => {
    const input = startRename();
    const outside = screen.getByRole("button", { name: OUTSIDE_LABEL });
    fireEvent.change(input, { target: { value: "yanjiu" } });
    fireEvent.compositionStart(input);

    act(() => {
      outside.focus();
    });

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: RENAME_LABEL })).not.toBeInTheDocument();
    });
    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Original title")).toBeInTheDocument();
  });

  it("still submits the current value when focus moves outside", () => {
    const input = startRename();
    const outside = screen.getByRole("button", { name: OUTSIDE_LABEL });
    fireEvent.change(input, { target: { value: "Blurred title" } });

    act(() => {
      outside.focus();
    });

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      sessionId: "session-1",
      title: "Blurred title",
    });
    expect(outside).toHaveFocus();
  });

  it.each([
    ["standard composition signal", { isComposing: true, keyCode: 27 }],
    ["Safari composition signal", { isComposing: false, keyCode: 229 }],
  ])("keeps editing when Escape carries the %s", (_name, eventInit) => {
    const input = startRename();
    fireEvent.change(input, { target: { value: "yanjiu" } });

    fireEvent.keyDown(input, { key: "Escape", ...eventInit });

    expect(updateMutate).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("yanjiu");
  });

  it("still cancels the edit on Escape", () => {
    const input = startRename();
    fireEvent.change(input, { target: { value: "Discard me" } });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: RENAME_LABEL })).not.toBeInTheDocument();
    expect(screen.getByText("Original title")).toBeInTheDocument();
  });
});

describe("ChatSessionHeader deletion ownership", () => {
  beforeEach(() => {
    deleteMutate.mockReset();
    setActiveSession.mockReset();
  });

  async function confirmDeletion(onDeletedSession?: (sessionId: string) => void) {
    render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatSessionHeader
          session={{ ...session, status: "archived" }}
          agent={null}
          onDeletedSession={onDeletedSession}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: enCommon.more_actions }));
    fireEvent.click(await screen.findByRole("menuitem", { name: enChat.header.delete }));
    fireEvent.click(await screen.findByRole("button", {
      name: enChat.session_history.delete_dialog.confirm,
    }));
  }

  it("only delegates successful deletion and leaves Chat selection alone", async () => {
    const onDeletedSession = vi.fn();
    await confirmDeletion(onDeletedSession);

    expect(deleteMutate).toHaveBeenCalledWith("session-1", expect.any(Object));
    expect(onDeletedSession).not.toHaveBeenCalled();
    expect(setActiveSession).not.toHaveBeenCalled();

    const callbacks = deleteMutate.mock.calls[0]![1] as { onSuccess: () => void };
    act(() => callbacks.onSuccess());

    expect(onDeletedSession).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(setActiveSession).not.toHaveBeenCalled();
  });

  it("does not notify deletion before a failed request completes", async () => {
    const onDeletedSession = vi.fn();
    await confirmDeletion(onDeletedSession);
    const callbacks = deleteMutate.mock.calls[0]![1] as { onError?: () => void };

    act(() => callbacks?.onError?.());

    expect(onDeletedSession).not.toHaveBeenCalled();
    expect(setActiveSession).not.toHaveBeenCalled();
  });

  it("keeps the default Chat selection cleanup before deleting", async () => {
    await confirmDeletion();

    expect(setActiveSession).toHaveBeenCalledExactlyOnceWith(null);
    expect(deleteMutate).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(setActiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMutate.mock.invocationCallOrder[0]!,
    );
  });
});
