// @vitest-environment node
import { expect, it } from "vitest";
import { mentionTaskStatus, mentionTaskTitle } from "./mention-task-presentation";

it("uses Multica's built-in labels and lifecycle categories, preserving custom and unknown statuses", () => {
  for (const [status, label, category] of [
    ["backlog", "待规划", "unstarted"], ["todo", "待办", "unstarted"],
    ["in_progress", "进行中", "started"], ["in_review", "审核中", "started"],
    ["blocked", "已阻塞", "started"], ["done", "已完成", "done"], ["cancelled", "已取消", "closed"],
  ]) expect(mentionTaskStatus({ status }, "zh-CN")).toEqual({ label, category });
  expect(mentionTaskStatus({ status: "in_review" }, "en")).toEqual({ label: "In Review", category: "started" });
  expect(mentionTaskStatus({ status: "qa", statusLabel: "等待验收", statusCategory: "started" }, "zh-CN")).toEqual({ label: "等待验收", category: "started" });
  expect(mentionTaskStatus({ status: "future_status" }, "en")).toEqual({ label: "future_status", category: "unknown" });
  expect(mentionTaskStatus({ status: "toString" }, "en")).toEqual({ label: "toString", category: "unknown" });
  expect(mentionTaskStatus({}, "zh-CN")).toBeNull();
});

it("separates a task identifier without changing titles that contain no identifier", () => {
  expect(mentionTaskTitle("TES-124 修复访客访问权限")).toEqual({ identifier: "TES-124", title: "修复访客访问权限" });
  expect(mentionTaskTitle("Release review")).toEqual({ identifier: null, title: "Release review" });
});
