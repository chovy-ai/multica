import { describe, expect, it } from "vitest";
import { createLocalAgentGUIAgentTarget } from "../../../agentTargets";
import {
  applyAgentGUIProviderRailOrder,
  applyAgentGUIProviderRailVisibility,
  agentGUIRunningTargetIds,
  changeAgentGUIProviderManagerVisibility,
  normalizeAgentGUIProviderRailHiddenTargetIds,
  parseAgentGUIProviderRailOrder,
  parseAgentGUIProviderRailPreferences,
  reorderAgentGUIProviderRailOrder,
  serializeAgentGUIProviderRailOrder,
  serializeAgentGUIProviderRailPreferences
} from "./agentGuiProviderRailOrder";

describe("agent gui provider rail order", () => {
  it("parses and serializes versioned order and visibility preferences", () => {
    const serialized = serializeAgentGUIProviderRailPreferences({
      hiddenTargetIds: [" local:cursor ", "local:cursor", ""],
      order: [" local:claude-code ", "local:codex", "local:codex"]
    });

    expect(serialized).toBe(
      '{"version":1,"order":["local:claude-code","local:codex"],"hiddenTargetIds":["local:cursor"]}'
    );
    expect(parseAgentGUIProviderRailPreferences(serialized)).toEqual({
      hiddenTargetIds: ["local:cursor"],
      order: ["local:claude-code", "local:codex"]
    });
    expect(parseAgentGUIProviderRailPreferences("not json")).toEqual({
      hiddenTargetIds: [],
      order: []
    });
  });

  it("parses and serializes sanitized target ids", () => {
    const serialized = serializeAgentGUIProviderRailOrder([
      " local:codex ",
      "local:codex",
      "",
      "local:claude-code"
    ]);

    expect(serialized).toBe('["local:codex","local:claude-code"]');
    expect(parseAgentGUIProviderRailOrder(serialized)).toEqual([
      "local:codex",
      "local:claude-code"
    ]);
    expect(parseAgentGUIProviderRailOrder("not json")).toEqual([]);
    expect(parseAgentGUIProviderRailOrder('{"order":[]}')).toEqual([]);
  });

  it("applies known target order before unknown targets", () => {
    const codex = { targetId: "local:codex" };
    const claude = { targetId: "local:claude-code" };
    const cursor = { targetId: "local:cursor" };

    expect(
      applyAgentGUIProviderRailOrder(
        [codex, claude, cursor],
        ["local:cursor", "local:codex"]
      )
    ).toEqual([cursor, codex, claude]);
  });

  it("filters hidden targets without changing the full ordered collection", () => {
    const codex = { targetId: "local:codex" };
    const claude = { targetId: "local:claude-code" };
    const cursor = { targetId: "local:cursor" };

    expect(
      applyAgentGUIProviderRailVisibility(
        [cursor, codex, claude],
        ["local:codex", "unknown"]
      )
    ).toEqual([cursor, claude]);
  });

  it("projects working and waiting conversations to protected agent targets", () => {
    const codex = createLocalAgentGUIAgentTarget("codex");
    const claude = createLocalAgentGUIAgentTarget("claude-code");
    const conversation = {
      cwd: "/workspace",
      id: "session-codex",
      provider: "codex" as const,
      status: "working" as const,
      title: "Codex run",
      updatedAtUnixMs: 1
    };

    expect(
      agentGUIRunningTargetIds({
        activeConversation: conversation,
        agentTargets: [codex, claude],
        conversations: [
          { ...conversation, agentTargetId: codex.targetId },
          {
            ...conversation,
            agentTargetId: null,
            id: "session-claude",
            provider: "claude-code",
            status: "waiting"
          },
          { ...conversation, id: "session-ready", status: "ready" }
        ]
      })
    ).toEqual([codex.targetId, claude.targetId]);
  });

  it("recovers the first target when stored preferences hide every target", () => {
    expect(
      normalizeAgentGUIProviderRailHiddenTargetIds(
        ["codex", "claude"],
        ["codex", "claude"]
      )
    ).toEqual(["claude"]);
    expect(
      applyAgentGUIProviderRailVisibility(
        [{ targetId: "codex" }, { targetId: "claude" }],
        ["codex", "claude"]
      )
    ).toEqual([{ targetId: "codex" }]);
  });

  it("reorders one target around another target", () => {
    const currentTargetIds = [
      "local:codex",
      "local:claude-code",
      "local:cursor"
    ];

    expect(
      reorderAgentGUIProviderRailOrder({
        currentTargetIds,
        draggedTargetId: "local:cursor",
        dropPosition: "before",
        overTargetId: "local:codex"
      })
    ).toEqual(["local:cursor", "local:codex", "local:claude-code"]);
    expect(
      reorderAgentGUIProviderRailOrder({
        currentTargetIds,
        draggedTargetId: "local:codex",
        dropPosition: "after",
        overTargetId: "local:cursor"
      })
    ).toEqual(["local:claude-code", "local:cursor", "local:codex"]);
  });

  it("changes visibility and placement atomically", () => {
    expect(
      changeAgentGUIProviderManagerVisibility({
        currentTargetIds: ["codex", "claude", "cursor"],
        placement: { overTargetId: "claude", position: "before" },
        preferences: { hiddenTargetIds: ["cursor"], order: [] },
        targetId: "cursor",
        visible: true
      })
    ).toEqual({
      hiddenTargetIds: [],
      order: ["codex", "cursor", "claude"]
    });
  });

  it("refuses to hide the final available target", () => {
    const preferences = {
      hiddenTargetIds: ["claude"],
      order: ["codex", "claude"]
    };

    expect(
      changeAgentGUIProviderManagerVisibility({
        currentTargetIds: ["codex", "claude"],
        preferences,
        targetId: "codex",
        visible: false
      })
    ).toBe(preferences);
  });

  it("refuses to hide a running target", () => {
    const preferences = {
      hiddenTargetIds: [],
      order: ["codex", "claude"]
    };

    expect(
      changeAgentGUIProviderManagerVisibility({
        currentTargetIds: ["codex", "claude"],
        preferences,
        runningTargetIds: ["codex"],
        targetId: "codex",
        visible: false
      })
    ).toBe(preferences);
  });
});
