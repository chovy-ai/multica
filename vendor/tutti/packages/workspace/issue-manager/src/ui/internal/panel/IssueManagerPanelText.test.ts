import assert from "node:assert/strict";
import test from "node:test";

import {
  stripIssueManagerDescriptionTerminalPunctuation,
  summarizeIssueManagerContent
} from "./IssueManagerPanelText.ts";

test("strips terminal sentence punctuation from description text", () => {
  assert.equal(
    stripIssueManagerDescriptionTerminalPunctuation("需要先安装本地 Agent。"),
    "需要先安装本地 Agent"
  );
  assert.equal(
    stripIssueManagerDescriptionTerminalPunctuation("Use this agent."),
    "Use this agent"
  );
  assert.equal(
    stripIssueManagerDescriptionTerminalPunctuation("正在处理..."),
    "正在处理..."
  );
});

test("summarizes issue content without terminal sentence punctuation", () => {
  assert.equal(
    summarizeIssueManagerContent("这个任务还没有描述。", ""),
    "这个任务还没有描述"
  );
});
