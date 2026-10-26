import { describe, expect, it } from "vitest";
import {
  AGENT_GUI_WORKBENCH_COMMAND_EVENT,
  dispatchAgentGuiWorkbenchCommand,
  isAgentGuiWorkbenchSessionAction,
  normalizeAgentGuiWorkbenchCommand,
  type AgentGuiWorkbenchCommand
} from "./commands.ts";

describe("isAgentGuiWorkbenchSessionAction", () => {
  it.each(["rename", "copy-markdown", "copy-reference"] as const)(
    "accepts %s",
    (action) => {
      expect(isAgentGuiWorkbenchSessionAction(action)).toBe(true);
    }
  );

  it.each(["pin", "delete", "copy", "", 42, null, undefined])(
    "rejects %s",
    (value) => {
      expect(isAgentGuiWorkbenchSessionAction(value)).toBe(false);
    }
  );
});

describe("normalizeAgentGuiWorkbenchCommand", () => {
  it("normalizes the optional session id", () => {
    expect(
      normalizeAgentGuiWorkbenchCommand({
        action: "copy-reference",
        agentSessionId: " session-1 ",
        instanceId: "instance-1",
        type: "session-action"
      })
    ).toEqual({
      action: "copy-reference",
      agentSessionId: "session-1",
      instanceId: "instance-1",
      type: "session-action"
    });
  });

  it.each([
    null,
    {},
    { instanceId: "", type: "new-conversation" },
    {
      conversationRailCollapsed: "true",
      instanceId: "instance-1",
      type: "conversation-rail-toggle"
    },
    {
      action: "delete",
      agentSessionId: null,
      instanceId: "instance-1",
      type: "session-action"
    }
  ])("rejects malformed command %j", (command) => {
    expect(normalizeAgentGuiWorkbenchCommand(command)).toBeNull();
  });
});

describe("dispatchAgentGuiWorkbenchCommand", () => {
  it("dispatches every command without collapsing repeated actions", () => {
    const received: AgentGuiWorkbenchCommand[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<AgentGuiWorkbenchCommand>).detail);
    };
    window.addEventListener(AGENT_GUI_WORKBENCH_COMMAND_EVENT, listener);
    const command: AgentGuiWorkbenchCommand = {
      action: "rename",
      agentSessionId: null,
      instanceId: "instance-1",
      type: "session-action"
    };
    try {
      dispatchAgentGuiWorkbenchCommand(command);
      dispatchAgentGuiWorkbenchCommand(command);
    } finally {
      window.removeEventListener(AGENT_GUI_WORKBENCH_COMMAND_EVENT, listener);
    }
    expect(received).toEqual([command, command]);
  });
});
