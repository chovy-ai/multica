// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderedReply, ReplyPresentationProvider } from "./rendered-reply";
import type { AgentGuiRpcClient } from "./protocol";
import { normalizeAgentActivitySession, type AgentActivityTurn } from "@tutti-os/agent-activity-core";
import { projectAgentConversationVM } from "../../../vendor/tutti/packages/agent/gui/shared/agentConversation/projection/agentConversationProjection";

let root: Root;
let container: HTMLDivElement;
const request = vi.fn().mockResolvedValue(undefined);
const client: AgentGuiRpcClient = { request, subscribe: () => () => {} };
const message = (id = "reply-1", session = "gui-session") => ({
  isTurnFinalText: true as const,
  sourceTimelineItems: [{ eventId: id, agentSessionId: session, messageSemantics: { userVisibleAssistantResponse: true, turnSettling: true } }],
});
const view = (reply: Parameters<typeof RenderedReply>[0]["message"] = message(), active = true, enabled = true) => <ReplyPresentationProvider client={client} enabled={enabled} active={active} sessionId="gui-session" toServerSessionId={() => "server-session"}>
  <RenderedReply message={reply}><p>{reply.sourceTimelineItems?.map((item) => item.eventId).join(" ")}</p></RenderedReply>
</ReplyPresentationProvider>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => window.setTimeout(callback, 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  request.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const paint = () => act(async () => { await vi.advanceTimersByTimeAsync(16); });

describe("reply presentation receipts", () => {
  it("retains the identity of each reply when the production projection merges adjacent text", async () => {
    const turn: AgentActivityTurn = { agentSessionId: "gui-session", turnId: "turn", phase: "settled", origin: "user_prompt", outcome: "completed", startedAtUnixMs: 1, updatedAtUnixMs: 2, settledAtUnixMs: 2 };
    const messages = ["reply-1", "reply-2"].map((id, index) => ({
      id, body: id, turnId: "turn", occurredAtUnixMs: index + 1,
      sourceTimelineItems: [{ ...message(id).sourceTimelineItems[0]!, id: index + 1, turnId: "turn", actorType: "agent", actorId: "gui-session", itemType: "message.assistant", role: "assistant", content: id }],
    }));
    const agentItems = messages.map((value) => ({ kind: "message" as const, message: value }));
    const conversation = projectAgentConversationVM({
      activity: { id: "activity", sessionId: "gui-session", agentName: "Codex", agentProvider: "codex", title: "Conversation", latestActivitySummary: "Finished", status: "working", sortTimeUnixMs: 2, changedFiles: [], userId: "user", userName: "User", userAvatarUrl: "" },
      session: normalizeAgentActivitySession({ workspaceId: "workspace", agentSessionId: "gui-session", userId: "user", provider: "codex", providerSessionId: "provider-session", cwd: "", title: "Conversation", createdAtUnixMs: 1, updatedAtUnixMs: 2, activeTurnId: null, latestTurn: turn, latestTurnInteractions: [], pendingInteractions: [] }),
      cwd: "", workspaceRoot: null, sessionTurns: [turn], showProcessingIndicator: false,
      turns: [{ id: "turn", userMessage: null, userMessages: [], agentMessages: messages, toolCalls: [], toolCallCount: 0, hasFailedToolCall: false, agentItems, rawAgentItems: agentItems }],
    });
    const merged = conversation.rows.flatMap((row) => row.kind === "message" ? row.messages : []).find((entry) => entry.isTurnFinalText)!;
    expect(merged.body).toBe("reply-1\nreply-2");
    expect(merged.sourceTimelineItems?.map((item) => item.eventId)).toEqual(["reply-1", "reply-2"]);
    await act(async () => root.render(view(merged))); await paint();
    expect(request).toHaveBeenLastCalledWith("session.markRead", { sessionId: "server-session", messageId: "reply-2" });
  });
  it("acknowledges the committed reply ID and acknowledges a later reply in the same turn separately", async () => {
    request.mockImplementation(async () => { expect(container.textContent).toContain(request.mock.calls.at(-1)![1].messageId); });
    await act(async () => root.render(view()));
    expect(request).not.toHaveBeenCalled();
    await paint();
    expect(request).toHaveBeenLastCalledWith("session.markRead", { sessionId: "server-session", messageId: "reply-1" });
    await act(async () => root.render(view())); await paint();
    expect(request).toHaveBeenCalledOnce();
    await act(async () => root.render(view(message("reply-2")))); await paint();
    expect(request).toHaveBeenLastCalledWith("session.markRead", { sessionId: "server-session", messageId: "reply-2" });
  });
  it("waits for an active local presentation and ignores another session or streaming text", async () => {
    for (const element of [view(message(), false), view(message(), true, false), view(message("other", "other-session")), view({ ...message(), isTurnFinalText: undefined })]) {
      await act(async () => root.render(element)); await paint();
      expect(request).not.toHaveBeenCalled();
    }
    await act(async () => root.render(view())); await paint();
    expect(request).toHaveBeenCalledOnce();
  });
  it("cancels a receipt if its reply is replaced before the frame and retries after refocusing on a rejected receipt", async () => {
    await act(async () => root.render(view()));
    await act(async () => root.render(view(message("new-reply"), false))); await paint();
    expect(request).not.toHaveBeenCalled();
    request.mockRejectedValueOnce(new Error("inactive host"));
    await act(async () => root.render(view(message("new-reply")))); await paint();
    await act(async () => root.render(view(message("new-reply"), false)));
    await act(async () => root.render(view(message("new-reply")))); await paint();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("session.markRead", { sessionId: "server-session", messageId: "new-reply" });
  });
});
