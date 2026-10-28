import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@tutti-os/ui-system/components";
import { RefreshIcon } from "@tutti-os/ui-system/icons";
import { Minimize2, LoaderCircle } from "lucide-react";
import type { AgentGuiRpcClient } from "./protocol";
import type { LocalProviderUsage, LocalUsageWindow } from "./local-protocol";

export function remainingPercent(window: LocalUsageWindow, now = Date.now()): number | null {
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) return null;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}
export function contextPercent(usage: LocalProviderUsage | null): number | null {
  const context = usage?.context;
  return context?.usedTokens != null && context.limitTokens != null && context.limitTokens > 0
    ? Math.min(100, Math.max(0, context.usedTokens / context.limitTokens * 100)) : null;
}
function Meter({ value, label }: { value: number; label: string }) {
  return <div className="multica-usage-meter" role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
    <span style={{ width: `${value}%` }} />
  </div>;
}
function UsageRing({ value }: { value: number | null }) {
  return <svg className="multica-usage-ring" viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true" focusable="false">
    <circle className="multica-usage-ring-track" cx="10" cy="10" r="8" />
    {value !== null && value > 0 && <circle className="multica-usage-ring-fill" cx="10" cy="10" r="8" pathLength="100" strokeDasharray={`${value} 100`} transform="rotate(-90 10 10)" />}
  </svg>;
}
interface Props { client: AgentGuiRpcClient; agentId: string; sessionId: string | null; chinese: boolean; busy: boolean; active: boolean }
export function UsageIndicator({ client, agentId, sessionId, chinese, busy, active }: Props) {
  return <UsageIndicatorContent key={`${agentId}:${sessionId ?? ""}`} client={client} agentId={agentId} sessionId={sessionId} chinese={chinese} busy={busy} active={active} />;
}
function UsageIndicatorContent({ client, agentId, sessionId, chinese, busy, active }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<LocalProviderUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<{ error?: string } | null>(null);
  const compactPending = useRef(false);
  const actionSequence = useRef(0);
  const invalidateActions = useCallback(() => { actionSequence.current++; }, []);
  const sequence = useRef(0);
  const hostDismissed = useRef(false);
  const invalidatePending = useCallback(() => { sequence.current++; }, []);
  const labels = chinese ? {
    usage: "用量", context: "当前会话上下文", account: "账号剩余额度", refresh: "刷新用量", loading: "正在读取用量…",
    contextEmpty: "暂无上下文数据", limitUnknown: "上限未提供", accountEmpty: "当前运行器未提供账号额度", error: "无法更新用量，请重试",
    stale: "更新失败，显示上次数据", expired: "等待刷新", resets: "重置", updated: "更新于", shared: "账号额度由本机 CLI 的所有会话共享。",
    fiveHour: "5 小时窗口", weekly: "每周窗口", contextChip: "上下文", left: "剩余",
    compact: "压缩上下文", compacting: "正在压缩上下文…", compactDone: "压缩已完成；用量可能在下一轮回复后更新。",
    compactFailed: "上下文压缩失败：", empty: "发送消息后可压缩上下文", busy: "请等待当前执行及后台任务结束", queued: "请先发送或移除排队消息", archived: "归档会话无法压缩", unsupported: "当前桌面运行时未提供压缩能力，请完整重启或更新应用",
  } : {
    usage: "Usage", context: "Conversation context", account: "Account remaining", refresh: "Refresh usage", loading: "Loading usage…",
    contextEmpty: "No context data yet", limitUnknown: "Limit not reported", accountEmpty: "This provider does not report account limits", error: "Could not update usage. Try again.",
    stale: "Update failed; showing previous data", expired: "Awaiting refresh", resets: "Resets", updated: "Updated", shared: "Account limits are shared across this CLI account's conversations.",
    fiveHour: "5-hour window", weekly: "Weekly window", contextChip: "Context", left: "left",
    compact: "Compact context", compacting: "Compacting context…", compactDone: "Context compacted. Usage may update after the next reply.",
    compactFailed: "Context compaction failed: ", empty: "Send a message before compacting", busy: "Wait for foreground and background tasks to finish", queued: "Send or remove queued messages first", archived: "Archived conversations cannot be compacted", unsupported: "This desktop runtime does not expose compaction. Fully restart or update the app.",
  };
  const load = useCallback(async (force = false) => {
    const current = ++sequence.current;
    setLoading(true); setFailed(false);
    try {
      const next = await client.request("usage.read", { agentId, ...(sessionId ? { sessionId } : {}), force });
      if (current === sequence.current) setData(next);
    } catch { if (current === sequence.current) setFailed(true); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [client, agentId, sessionId]);
  const compact = async () => {
    if (!sessionId || busy || compactPending.current || data?.compaction?.status !== "ready") return;
    compactPending.current = true;
    const current = ++actionSequence.current;
    setCompacting(true); setCompactResult(null);
    try {
      await client.request("session.compact", { sessionId });
      if (current !== actionSequence.current) return;
      setCompactResult({});
      await load(true);
    } catch (error) {
      if (current === actionSequence.current) setCompactResult({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (current === actionSequence.current) { compactPending.current = false; setCompacting(false); }
    }
  };
  useEffect(() => {
    setData(null);
    return () => { invalidatePending(); invalidateActions(); };
  }, [load, invalidatePending, invalidateActions]);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && active) void load();
    wasBusy.current = busy;
  }, [busy, active, load]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => clearInterval(timer);
  }, [active, load]);
  useEffect(() => {
    if (!active || data?.compaction?.status !== "running") return;
    const timer = setInterval(() => { void load(); }, 2_000);
    return () => clearInterval(timer);
  }, [active, data?.compaction?.status, load]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => { hostDismissed.current = true; setOpen(false); };
    const unsubscribe = client.subscribe((event) => {
      if (event.type === "dismissPopovers" || (event.type === "init" && (event.snapshot.hostVisible === false || event.snapshot.activeSessionId !== sessionId))) dismiss();
    });
    // Focus can move straight from this frame to another embedded side panel.
    window.addEventListener("blur", dismiss);
    return () => { unsubscribe(); window.removeEventListener("blur", dismiss); };
  }, [client, open, sessionId]);
  const percent = contextPercent(data);
  const overallWindows = data?.account.windows.filter((item) => data.provider === "claude"
    ? item.id === "five_hour" || item.id === "seven_day" : item.id.startsWith("codex:")) ?? [];
  const available = overallWindows.map((item) => remainingPercent(item)).filter((value): value is number => value !== null);
  const left = available.length ? Math.min(...available) : null;
  const format = (value: number) => value.toLocaleString(chinese ? "zh-CN" : "en-US");
  const formatTime = (value: string) => new Intl.DateTimeFormat(chinese ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  const chip = percent !== null ? `${labels.contextChip} ${Math.round(percent)}%`
    : data?.context.usedTokens != null ? `${labels.contextChip} ${format(data.context.usedTokens)}` : labels.usage;
  const running = compacting || data?.compaction?.status === "running";
  const compactReason = !sessionId ? labels.empty : busy ? labels.busy : data?.compaction?.reason ? labels[data.compaction.reason] : !data?.compaction ? labels.unsupported : labels.compact;
  return <Popover open={open} onOpenChange={(value) => { hostDismissed.current = false; setOpen(value); if (value) void load(); }}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="multica-usage-trigger" aria-label={labels.usage} data-testid="multica-usage-trigger" aria-busy={loading || undefined}>
        <UsageRing value={percent} />
        <span>{chip}</span>
        {left !== null && !data?.account.stale && <span className="multica-usage-summary">{labels.left} {Math.floor(left)}%</span>}
      </Button>
    </PopoverTrigger>
    <PopoverContent className="multica-usage-popover nodrag" align="end" side="top" aria-label={labels.usage}
      onCloseAutoFocus={(event) => { if (hostDismissed.current) { event.preventDefault(); hostDismissed.current = false; } }}>
      <div className="multica-usage-heading"><strong>{labels.usage}</strong><div className="multica-usage-actions">
        <Button variant="ghost" size="icon-sm" aria-label={labels.compact} title={running ? labels.compacting : compactReason} disabled={busy || running || data?.compaction?.status !== "ready" || !sessionId} aria-busy={running || undefined} onClick={() => { void compact(); }}>
          {running ? <LoaderCircle className="multica-usage-spinner" aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={labels.refresh} disabled={loading || running} onClick={() => { void load(true); }}><RefreshIcon aria-hidden="true" /></Button>
      </div></div>
      {running ? <p className="multica-usage-detail" role="status">{labels.compacting}</p> : compactResult ? <p className="multica-usage-detail" role={compactResult.error ? "alert" : "status"}>{compactResult.error ? labels.compactFailed + compactResult.error : labels.compactDone}</p> : null}
      <section className="multica-usage-section" aria-label={labels.context}>
        <div className="multica-usage-row"><span>{labels.context}</span>{percent !== null && <strong>{percent.toFixed(1)}%</strong>}</div>
        {data?.context.usedTokens != null ? <>
          <div className="multica-usage-detail">{format(data.context.usedTokens)}{data.context.limitTokens ? ` / ${format(data.context.limitTokens)}` : ` · ${labels.limitUnknown}`} tokens</div>
          {percent !== null && <Meter value={percent} label={labels.context} />}
          {data.context.model && <div className="multica-usage-detail multica-usage-model">{data.context.model}</div>}
        </> : <p className="multica-usage-detail">{loading ? labels.loading : labels.contextEmpty}</p>}
      </section>
      <section className="multica-usage-section" aria-label={labels.account}>
        <div className="multica-usage-row"><span>{labels.account}</span>{data?.account.plan && <span className="multica-usage-plan">{data.account.plan}</span>}</div>
        {data?.account.windows.map((item) => {
          const remaining = remainingPercent(item);
          const label = item.id === "five_hour" || item.label === "5h" ? labels.fiveHour : item.id === "seven_day" || item.label === "7d" ? labels.weekly : item.label;
          return <div className="multica-usage-window" key={item.id}>
            <div className="multica-usage-row"><span>{label}</span><strong>{remaining === null ? labels.expired : `${Math.floor(remaining)}%`}</strong></div>
            {remaining !== null && <Meter value={remaining} label={label} />}
            {item.resetsAt && <div className="multica-usage-detail">{labels.resets} {formatTime(item.resetsAt)}</div>}
          </div>;
        })}
        {!data?.account.windows.length && <p className="multica-usage-detail">{loading ? labels.loading : data?.account.status === "error" || failed ? labels.error : labels.accountEmpty}</p>}
        {(data?.account.stale || failed) && Boolean(data?.account.windows.length) && <p role="status" className="multica-usage-detail">{labels.stale}</p>}
        {data?.account.updatedAt && <div className="multica-usage-detail">{labels.updated} {formatTime(data.account.updatedAt)}</div>}
      </section>
      <p className="multica-usage-detail">{labels.shared}</p>
    </PopoverContent>
  </Popover>;
}
