"use client";

import type { Agent, ChatSession } from "@multica/core/types";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "@nextop-os/ui-system/components";
import { MoreHorizontalIcon, PinFilledIcon } from "@nextop-os/ui-system/icons";
import { ActorAvatar } from "../common/actor-avatar";
import { useLocale, useT } from "../i18n";

export function AgentWorkspaceSessionRow({
  session,
  agent,
  active,
  running,
  offline,
  actionPending,
  onSelect,
  onTogglePin,
  onArchive,
  onUnarchive,
}: {
  session: ChatSession;
  agent?: Agent;
  active: boolean;
  running: boolean;
  offline: boolean;
  actionPending: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  const { t } = useT("chat");
  const locale = useLocale();
  const message = session.last_message;
  const activityTimestamp = [message?.created_at, session.updated_at]
    .find((value) => value && Number.isFinite(Date.parse(value)));
  const activity = activityTimestamp ? new Date(activityTimestamp) : null;
  const now = new Date();
  const time = !activity ? null : activity.toDateString() === now.toDateString()
    ? activity.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : activity.toLocaleDateString(locale, {
      month: "numeric",
      day: "numeric",
      ...(activity.getFullYear() !== now.getFullYear() ? { year: "numeric" } as const : {}),
    });
  const unread = active ? 0 : session.unread_count ?? (session.has_unread ? 1 : 0);
  let preview = t(($) => $.list.no_messages);
  if (running) {
    preview = offline ? t(($) => $.list.waiting) : t(($) => $.list.typing);
  } else if (message?.failure_reason) {
    preview = t(($) => $.list.failed);
  } else if (message?.message_kind === "no_response") {
    preview = t(($) => $.list.no_response_preview);
  } else if (message) {
    const content = message.content.replace(/```[\s\S]*?```|[#*`>~]/g, " ").replace(/\s+/g, " ").trim();
    preview = `${message.role === "user" ? t(($) => $.list.you_prefix) : ""}${content}`;
  }

  return (
    <div className="group/session relative mt-1 flex min-w-0 items-center gap-0.5">
      <Button
        className="agent-workspace-list-row agent-workspace-session-row min-w-0 flex-1 justify-start"
        variant={active ? "secondary" : "ghost"}
        aria-pressed={active}
        onClick={onSelect}
      >
        <ActorAvatar actorType="agent" actorId={session.agent_id} size="md" profileLink={false} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
          <span className="flex min-w-0 items-center gap-1">
            {session.pinned && <PinFilledIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t(($) => $.list.pinned)} />}
            <span className={`min-w-0 flex-1 truncate ${unread > 0 ? "font-semibold" : ""}`}>
              {session.title.trim() || t(($) => $.workbench.untitled)}
            </span>
            {activity && <time dateTime={activityTimestamp} title={activity.toLocaleString(locale)} className="shrink-0 text-micro font-normal text-muted-foreground">{time}</time>}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-caption font-normal text-muted-foreground">
            {agent && <><span className="max-w-[40%] shrink-0 truncate">{agent.name}</span><span aria-hidden="true">·</span></>}
            {running && !offline && <Spinner size={12} />}
            <span className={`min-w-0 flex-1 truncate ${!running && message?.failure_reason ? "text-destructive" : ""}`}>{preview}</span>
            {unread > 0 && <Badge variant="secondary" className="h-4 min-w-4 shrink-0 justify-center rounded-full px-1 tabular-nums" aria-label={t(($) => $.workbench.unread)}>{unread > 99 ? "99+" : unread}</Badge>}
          </span>
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            aria-label={t(($) => $.list.row_actions_aria)}
            disabled={actionPending}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="agent-workspace-menu min-w-40" align="end">
          {session.status === "archived" ? (
            <DropdownMenuItem onSelect={onUnarchive}>{t(($) => $.list.unarchive)}</DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={onTogglePin}>{session.pinned ? t(($) => $.list.unpin) : t(($) => $.list.pin)}</DropdownMenuItem>
              {!running && <DropdownMenuItem onSelect={onArchive}>{t(($) => $.list.archive)}</DropdownMenuItem>}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
