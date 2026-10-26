import { describe, expect, it } from "vitest";
import { agentGuiI18nResources } from "../i18n/index";
import {
  normalizeWorkspaceAgentActivityDisplayStatus,
  workspaceAgentActivityStatusLabel
} from "./workspaceAgentActivityStatusLabel";

const labels: Record<string, string> = {
  "agentHost.workspaceAgentActivityStatusWorking": "运行中",
  "agentHost.workspaceAgentActivityStatusWaiting": "等待中",
  "agentHost.workspaceAgentActivityStatusIdle": "已完成",
  "agentHost.workspaceAgentActivityStatusEnd": "已完成",
  "agentHost.workspaceAgentActivityStatusCompleted": "已完成",
  "agentHost.workspaceAgentActivityStatusCanceled": "已取消",
  "agentHost.workspaceAgentActivityStatusFailed": "错误"
};

describe("workspaceAgentActivityStatusLabel", () => {
  it("normalizes raw workspace agent activity statuses for shared display usage", () => {
    expect(normalizeWorkspaceAgentActivityDisplayStatus("working")).toBe(
      "working"
    );
    expect(normalizeWorkspaceAgentActivityDisplayStatus("waiting")).toBe(
      "waiting"
    );
    expect(normalizeWorkspaceAgentActivityDisplayStatus("idle")).toBe(
      "completed"
    );
    expect(normalizeWorkspaceAgentActivityDisplayStatus("ready")).toBe(
      "completed"
    );
    expect(normalizeWorkspaceAgentActivityDisplayStatus("completed")).toBe(
      "completed"
    );
    expect(normalizeWorkspaceAgentActivityDisplayStatus("end")).toBe(
      "completed"
    );
    expect(normalizeWorkspaceAgentActivityDisplayStatus("canceled")).toBe(
      "canceled"
    );
    expect(normalizeWorkspaceAgentActivityDisplayStatus("failed")).toBe(
      "failed"
    );
  });

  it("formats workspace agent activity statuses with the workspace status copy", () => {
    const t = (key: string): string => labels[key] ?? key;

    expect(workspaceAgentActivityStatusLabel("working", t)).toBe("运行中");
    expect(workspaceAgentActivityStatusLabel("waiting", t)).toBe("等待中");
    expect(workspaceAgentActivityStatusLabel("idle", t)).toBe("已完成");
    expect(workspaceAgentActivityStatusLabel("ready", t)).toBe("已完成");
    expect(workspaceAgentActivityStatusLabel("completed", t)).toBe("已完成");
    expect(workspaceAgentActivityStatusLabel("canceled", t)).toBe("已取消");
    expect(workspaceAgentActivityStatusLabel("failed", t)).toBe("错误");
  });

  it("keeps the message center's running filter/group label in sync with the shared activity status label in every locale", () => {
    // Regression guard: the message center panel shows a group/filter label
    // ("Running") right above cards whose own status pill is rendered via
    // workspaceAgentActivityStatusLabel for the same "working" status. These
    // must read as the same word in every locale, or the panel shows two
    // different labels for the same "running" state side by side (the exact
    // wording inconsistency reported against the message status panel).
    for (const locale of Object.keys(
      agentGuiI18nResources
    ) as (keyof typeof agentGuiI18nResources)[]) {
      const dictionary = agentGuiI18nResources[locale] as {
        agentHost: {
          workspaceAgentMessageCenterFilterWorking: string;
          workspaceAgentActivityStatusWorking: string;
        };
      };
      expect(
        dictionary.agentHost.workspaceAgentMessageCenterFilterWorking
      ).toBe(dictionary.agentHost.workspaceAgentActivityStatusWorking);
    }
  });
});
