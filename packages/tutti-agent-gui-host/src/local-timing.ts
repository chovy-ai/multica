import { parseLocalTiming, type LocalTimingFailure, type LocalTimingIdentity, type LocalTimingOutcome, type LocalTimingRecord, type LocalTimingStage } from "@multica/core/local-conversation/timing";

export * from "@multica/core/local-conversation/timing";

/** Diagnostics contain identifiers and timings only, never prompts or provider payloads. */
export const LOCAL_TIMING_PREFIX = "[local-turn-timing] ";
export function localTimingFailure(error: unknown): LocalTimingFailure {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/429|rate.?limit|insufficient|quota|余额不足/i.test(message)) return "rate_limit";
  if (/401|403|unauthorized|authentication|not signed in/i.test(message)) return "authentication";
  if (/abort|cancel/i.test(message)) return "cancelled";
  if (/websocket|disconnect|ECONN|ETIMEDOUT|fetch failed|timeout|timed out/i.test(message)) return "transport";
  return "other";
}
export type LocalTimingSink = (record: LocalTimingRecord) => void;

export const consoleLocalTiming: LocalTimingSink = (record) => {
  console.info(LOCAL_TIMING_PREFIX + JSON.stringify(record));
};

export function createLocalTiming(identity: LocalTimingIdentity, sink: LocalTimingSink = consoleLocalTiming) {
  const start = performance.now();
  const seen = new Set<LocalTimingStage>();
  const tools = new Map<string, number>();
  const active: { stage: LocalTimingStage }[] = [];
  let lastActivity = start;
  let phase: LocalTimingStage = "turn.execute";
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const write = (stage: LocalTimingStage, event: LocalTimingRecord["event"], extra: Partial<Pick<LocalTimingRecord, "durationMs" | "idleMs" | "outcome" | "failure">> = {}, background = false) => {
    if (closed && !background) return;
    try {
      const record = parseLocalTiming({ ...identity, version: 2, at: new Date().toISOString(), stage, event, elapsedMs: Math.round(performance.now() - start), ...(background ? { background: true } : {}), ...extra });
      if (record) sink(record);
    }
    catch { /* Diagnostics must not change execution or delivery. */ }
  };
  const span = async <T>(stage: LocalTimingStage, action: () => Promise<T>, background = false): Promise<T> => {
    const pending = { stage };
    if (!background) { phase = stage; active.push(pending); }
    const before = performance.now();
    write(stage, "start", {}, background);
    let outcome: LocalTimingOutcome = "completed";
    let failure: LocalTimingFailure | undefined;
    try { return await action(); }
    catch (error) { failure = localTimingFailure(error); outcome = failure === "cancelled" ? "cancelled" : "failed"; throw error; }
    finally {
      if (!background) active.splice(active.indexOf(pending), 1);
      write(stage, "end", { durationMs: Math.round(performance.now() - before), outcome, ...(failure ? { failure } : {}) }, background);
    }
  };
  return {
    mark(stage: LocalTimingStage, extra?: Partial<Pick<LocalTimingRecord, "durationMs" | "outcome" | "failure">>) {
      phase = stage; lastActivity = performance.now(); write(stage, "mark", extra);
    },
    once(stage: LocalTimingStage) { if (!seen.has(stage)) { seen.add(stage); this.mark(stage); } },
    activity() { lastActivity = performance.now(); },
    tool(type: "tool_use" | "tool_result", id: string | undefined) {
      if (closed || !id) return;
      phase = "provider.tool"; lastActivity = performance.now();
      if (type === "tool_use") {
        if (tools.has(id) || tools.size >= 512) return;
        tools.set(id, performance.now()); write(phase, "start");
      } else {
        const began = tools.get(id); tools.delete(id);
        write(phase, "end", began === undefined ? {} : { durationMs: Math.round(performance.now() - began) });
      }
    },
    measure<T>(stage: LocalTimingStage, action: () => Promise<T>): Promise<T> { return span(stage, action); },
    // Cleanup spans remain observable after foreground completion without extending its heartbeat.
    background<T>(stage: LocalTimingStage, action: () => Promise<T>): Promise<T> { return span(stage, action, true); },
    heartbeat() {
      if (timer || closed) return;
      timer = setInterval(() => write(active.at(-1)?.stage ?? phase, "wait", { idleMs: Math.round(performance.now() - lastActivity) }), 15_000);
    },
    close() { if (timer) clearInterval(timer); closed = true; },
    finish(outcome: LocalTimingOutcome) {
      write("turn.finished", "end", { outcome }); this.close();
    },
  };
}
export type LocalTiming = ReturnType<typeof createLocalTiming>;

/** Observe live turns only. Loading old history must not look like a new reply. */
export function createLocalPresentationTiming(sink: LocalTimingSink = consoleLocalTiming) {
  const turns = new Map<string, { timing: LocalTiming; output: boolean; terminal: boolean }>();
  return {
    applied(conversationId: string, turnId: string, hasOutput: boolean, terminal: boolean) {
      let turn = turns.get(turnId);
      if (!turn && terminal) return;
      if (!turn) {
        turn = { timing: createLocalTiming({ source: "gui", conversationId, turnId }, sink), output: false, terminal: false };
        turns.set(turnId, turn);
        if (turns.size > 512) turns.delete(turns.keys().next().value!);
      }
      if (hasOutput && !turn.output) { turn.output = true; turn.timing.mark("gui.first_output_applied"); }
      if (terminal && !turn.terminal) { turn.terminal = true; turn.timing.mark("gui.terminal_applied"); }
    },
  };
}
