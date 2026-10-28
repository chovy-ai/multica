/** Diagnostics contain identifiers and timings only, never prompts or provider payloads. */
export const LOCAL_TIMING_PREFIX = "[local-turn-timing] ";
export const LOCAL_TIMING_STAGES = [
  "gui.submit", "gui.first_output_applied", "gui.terminal_applied", "renderer.request", "renderer.first_output_received", "main.request",
  "queue.dispatch", "queue.context", "turn.persist", "turn.execute", "turn.result", "attachments.resolve",
  "context.prepare", "context.credentials", "context.mcp", "provider.lookup", "provider.config",
  "provider.spawn", "provider.sdk_ready", "provider.refresh", "provider.input_written", "provider.input_yielded",
  "provider.pool_admission", "provider.pool_wait", "provider.pool_create", "provider.pool_reused", "provider.bridge", "provider.handshake",
  "provider.thread_wait", "provider.thread_ready", "provider.turn_start", "provider.thread_unload",
  "provider.first_stdout", "provider.first_stderr", "provider.first_event", "provider.session_ready",
  "provider.first_output", "provider.first_text", "provider.tool", "provider.result", "provider.exit", "provider.failure", "provider.retry",
  "title.generate", "title.persist", "user.question", "images.save", "context.dispose", "images.recover", "turn.save", "turn.finished",
] as const;
export type LocalTimingStage = typeof LOCAL_TIMING_STAGES[number];
export type LocalTimingOutcome = "completed" | "failed" | "cancelled";
export type LocalTimingFailure = "rate_limit" | "authentication" | "transport" | "cancelled" | "other";
export function localTimingFailure(error: unknown): LocalTimingFailure {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/429|rate.?limit|insufficient|quota|余额不足/i.test(message)) return "rate_limit";
  if (/401|403|unauthorized|authentication|not signed in/i.test(message)) return "authentication";
  if (/abort|cancel/i.test(message)) return "cancelled";
  if (/websocket|disconnect|ECONN|ETIMEDOUT|fetch failed|timeout|timed out/i.test(message)) return "transport";
  return "other";
}
export interface LocalTimingIdentity {
  source: "main" | "renderer" | "gui";
  background?: boolean;
  conversationId: string;
  requestId?: string;
  turnId?: string;
  provider?: "codex" | "claude";
}
export interface LocalTimingRecord extends LocalTimingIdentity {
  version: 1;
  at: string;
  stage: LocalTimingStage;
  event: "start" | "end" | "mark" | "wait";
  elapsedMs: number;
  durationMs?: number;
  idleMs?: number;
  outcome?: LocalTimingOutcome;
  failure?: LocalTimingFailure;
}
export type LocalTimingSink = (record: LocalTimingRecord) => void;

/** Rebuild the allowlisted shape even for console records originating in another frame. */
export function parseLocalTiming(value: unknown): LocalTimingRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = (v: unknown) => typeof v === "string" && /^[\w:.-]{1,160}$/.test(v);
  const ms = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (raw.version !== 1 || !["main", "renderer", "gui"].includes(String(raw.source)) || !id(raw.conversationId)
    || !LOCAL_TIMING_STAGES.includes(raw.stage as LocalTimingStage) || !["start", "end", "mark", "wait"].includes(String(raw.event))
    || typeof raw.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.at) || !Number.isFinite(Date.parse(raw.at)) || !ms(raw.elapsedMs)) return null;
  if ((raw.requestId !== undefined && !id(raw.requestId)) || (raw.turnId !== undefined && !id(raw.turnId))) return null;
  const result: LocalTimingRecord = {
    version: 1, source: raw.source as LocalTimingIdentity["source"], conversationId: raw.conversationId as string,
    at: raw.at, stage: raw.stage as LocalTimingStage, event: raw.event as LocalTimingRecord["event"], elapsedMs: raw.elapsedMs as number,
  };
  if (raw.background === true) result.background = true;
  if (raw.requestId !== undefined) result.requestId = raw.requestId as string;
  if (raw.turnId !== undefined) result.turnId = raw.turnId as string;
  if (raw.provider === "codex" || raw.provider === "claude") result.provider = raw.provider;
  if (ms(raw.durationMs)) result.durationMs = raw.durationMs as number;
  if (ms(raw.idleMs)) result.idleMs = raw.idleMs as number;
  if (["completed", "failed", "cancelled"].includes(String(raw.outcome))) result.outcome = raw.outcome as LocalTimingOutcome;
  if (["rate_limit", "authentication", "transport", "cancelled", "other"].includes(String(raw.failure))) result.failure = raw.failure as LocalTimingFailure;
  return result;
}

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
      const record = parseLocalTiming({ ...identity, version: 1, at: new Date().toISOString(), stage, event, elapsedMs: Math.round(performance.now() - start), ...(background ? { background: true } : {}), ...extra });
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
