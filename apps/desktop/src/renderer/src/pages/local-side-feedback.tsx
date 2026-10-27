import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, CircleAlert, CircleHelp, CircleStop, Loader2, MessagesSquare } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "@multica/views/i18n";
import type { LocalConversation, LocalConversationScope } from "@multica/tutti-agent-gui-host/local-protocol";
import { getLocalConversationClient } from "../platform/local-conversation-client";
import { localSideActivity } from "./local-side-activity";

export const sideActivityKey = (scope: LocalConversationScope, id: string) => ["local-side-activity", scope.userId, scope.workspaceId, id] as const;

export function useSideActivity(scope: LocalConversationScope, id: string, summary: LocalConversation | undefined, active: boolean) {
  const { t } = useT("chat");
  const query = useQuery({
    queryKey: sideActivityKey(scope, id),
    queryFn: () => getLocalConversationClient(window.desktopAPI.localConversations).request(scope, "read", { id }),
    enabled: active, refetchOnMount: "always",
  });
  // The list can report a newly started turn before its detail request resolves.
  const live = summary && (summary.turns.some((turn) => turn.status === "running" || turn.backgroundTasks?.some((task) => task.status === "running")) || summary.promptQueue?.dispatchingRequestId);
  const session = live && (!query.data || summary.updatedAt > query.data.updatedAt) ? summary : query.data ?? summary;
  const activity = localSideActivity(session);
  const label = query.isError ? t($ => $.desktop.side_activity.unavailable) : !query.data && !live && query.isPending ? t($ => $.desktop.side_activity.loading) : t($ => $.desktop.side_activity[activity.state]);
  return { ...activity, label, query };
}

export function SideActivityIcon({ activity }: { activity: ReturnType<typeof useSideActivity> }) {
  const Icon = activity.spinning ? Loader2 : activity.state === "waiting" ? CircleHelp : activity.state === "completed" ? Check : activity.state === "failed" ? CircleAlert : activity.state === "cancelled" ? CircleStop : MessagesSquare;
  return <Icon aria-hidden="true" className={`size-4 shrink-0 ${activity.spinning ? "animate-spin motion-reduce:animate-none" : ""} ${activity.state === "failed" ? "text-destructive" : ""}`} />;
}

export function SideActivitySummary({ activity }: { activity: ReturnType<typeof useSideActivity> }) {
  const { t } = useT("chat");
  if (activity.state === "idle" && !activity.query.isError && !activity.query.isPending) return null;
  const current = activity.state === "running" || activity.state === "waiting";
  const description = activity.state === "waiting" ? "" : activity.background || (activity.tool ? (activity.toolFinished ? t($ => $.desktop.side_activity.finished_tool, { tool: activity.tool }) : t($ => $.desktop.side_activity.using_tool, { tool: activity.tool })) : activity.thinking ? t($ => $.desktop.side_activity.thinking) : activity.output || (current ? t($ => $.desktop.side_activity.first_output) : ""));
  const output = !current ? activity.output : "";
  return <div className="shrink-0 border-b bg-surface px-3 py-2 text-caption" data-testid="side-activity">
    <div className="flex items-center gap-2 text-muted-foreground">
      <SideActivityIcon activity={activity} />
      <span role="status">{activity.label}</span>
      {activity.totalTools > 0 && <span className="ml-auto">{t($ => $.desktop.side_activity.tool_progress, { completed: activity.completedTools, total: activity.totalTools })}</span>}
    </div>
    {activity.query.isError ? <div className="mt-1 flex items-center gap-2 text-muted-foreground"><span>{t($ => $.desktop.side_activity.load_failed)}</span><Button variant="link" size="xs" onClick={() => { void activity.query.refetch(); }}>{t($ => $.desktop.side_activity.retry)}</Button></div> : <>
      {current && description && <p className="mt-1 line-clamp-2 break-words text-muted-foreground" title={description}>{description}</p>}
      {activity.error && <p className="mt-1 max-h-20 overflow-auto break-words text-destructive">{activity.error}</p>}
      {output ? <details className="group mt-1">
        <summary className="cursor-pointer list-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex items-center gap-1 text-muted-foreground">{activity.state === "completed" ? t($ => $.desktop.side_activity.summary) : t($ => $.desktop.side_activity.partial_output)}<ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" /></span>
          <span className="mt-1 line-clamp-2 break-words text-foreground group-open:hidden">{output}</span>
        </summary>
        <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-foreground">{output}</p>
      </details> : !current && activity.state !== "idle" && <p className="mt-1 text-muted-foreground">{t($ => $.desktop.side_activity.no_output)}</p>}
    </>}
  </div>;
}
