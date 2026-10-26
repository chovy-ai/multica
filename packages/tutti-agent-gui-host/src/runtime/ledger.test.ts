import { describe, expect, it } from "vitest";
import type { AgentActivityDurableMessage } from "@tutti-os/agent-activity-core";
import { RuntimeLedger } from "./ledger";

type Message = Omit<AgentActivityDurableMessage, "version" | "sequence">;
const message = (id: string, turnId: string | null, role: string, at: number): Message => ({
  workspaceId: "workspace", agentSessionId: "session", messageId: id, turnId,
  role, kind: "text", payload: { content: id }, occurredAtUnixMs: at,
});

describe("conversation display ordering", () => {
  it("keeps prompt order when a new turn backfills output from an earlier clock", () => {
    const rows = [message("first", "one", "user", 100), message("second", "two", "user", 200),
      message("backfilled", "two", "assistant", 50), message("late-first", "one", "assistant", 250), message("reply", "two", "assistant", 300)];
    expect(new RuntimeLedger().project("session", rows).map((row) => row.messageId))
      .toEqual(["first", "late-first", "second", "backfilled", "reply"]);
    expect(rows.map((row) => row.messageId)).toEqual(["first", "second", "backfilled", "late-first", "reply"]);
  });

  it("uses known turn starts for executions without an authored prompt", () => {
    const rows = [message("first", "one", "user", 100), message("backfilled", "two", "assistant", 50)];
    expect(new RuntimeLedger().project("session", rows, new Map([["two", 200]])).map((row) => row.messageId)).toEqual(["first", "backfilled"]);
  });

  it("keeps simultaneous turns contiguous and preserves turnless history", () => {
    const rows = [message("legacy", null, "assistant", 50), message("first", "one", "user", 100), message("second", "two", "user", 100),
      message("reply-one", "one", "assistant", 200), message("reply-two", "two", "assistant", 200)];
    expect(new RuntimeLedger().project("session", rows).map((row) => row.messageId)).toEqual(["legacy", "first", "reply-one", "second", "reply-two"]);
  });

  it("revisions repositioned messages so cursor readers receive their updated sequence", () => {
    const ledger = new RuntimeLedger();
    const first = message("first", "one", "user", 100), second = message("second", "two", "user", 200);
    const initial = ledger.project("session", [first, second]);
    const next = ledger.project("session", [first, second, message("late-first", "one", "assistant", 250)]);
    expect(next.find((row) => row.messageId === "second")).toMatchObject({ sequence: 3 });
    expect(next.find((row) => row.messageId === "second")!.version).toBeGreaterThan(initial[1]!.version);
    expect(next[0]!.version).toBe(initial[0]!.version);
    expect(ledger.project("session", [first, second, message("late-first", "one", "assistant", 250)])).toEqual(next);
  });
});
