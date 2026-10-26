"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, ChatSession, Issue } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  pendingChatTasksOptions,
  sortChatSessions,
} from "@multica/core/chat/queries";
import { useWorkspacePresenceMap } from "@multica/core/agents";
import {
  useSetChatSessionArchived,
  useSetChatSessionPinned,
} from "@multica/core/chat/mutations";
import { toast } from "sonner";
import { Badge, Button, Input, Spinner } from "@nextop-os/ui-system/components";
import {
  AddIcon,
  NavAgentsIcon,
  SearchIcon,
  SettingsIcon,
  TaskIcon,
} from "@nextop-os/ui-system/icons";
import { AppLink } from "../navigation";
import { useT } from "../i18n";
import type { ChatController } from "../chat/components/use-chat-controller";
import { AgentTaskPanel } from "./agent-task-panel";
import { PageHeader } from "../layout/page-header";
import { ActorAvatar } from "../common/actor-avatar";
import { matchesPinyin } from "../editor/extensions/pinyin-match";
import { AgentWorkspaceSessionRow } from "./agent-workspace-session-row";

function matchesDirectorySearch(value: string, query: string) {
  return value.toLocaleLowerCase().includes(query) || matchesPinyin(value, query);
}

export function AgentWorkspace({
  controller: c,
  conversation,
  onStartChat,
  onSelectSession,
  onArchive,
  onReference,
}: {
  controller: ChatController;
  conversation: ReactNode;
  onStartChat: (agent: Agent) => void;
  onSelectSession: (session: ChatSession) => void;
  onArchive: (session: ChatSession) => void;
  onReference: (issue: Issue) => void;
}) {
  const { t } = useT("chat");
  const paths = useWorkspacePaths();
  const containerRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [pane, setPane] = useState<"directory" | "conversation" | "tasks">(
    "directory",
  );
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const setPinned = useSetChatSessionPinned();
  const setSessionArchived = useSetChatSessionArchived();
  const { data: pending } = useQuery(pendingChatTasksOptions(c.wsId));
  const presence = useWorkspacePresenceMap(c.wsId);
  const pendingSessionIds = useMemo(
    () => new Set(pending?.tasks.map((task) => task.chat_session_id) ?? []),
    [pending],
  );
  const agentById = useMemo(
    () => new Map(c.agents.map((agent) => [agent.id, agent])),
    [c.agents],
  );
  useEffect(() => {
    if (c.activeSessionId) setPane("conversation");
  }, [c.activeSessionId]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 640) {
        setPane((current) =>
          current === "directory" ? "conversation" : current,
        );
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const archivedCount = c.sessions.filter(
    (session) => session.status === "archived",
  ).length;
  useEffect(() => {
    if (archived && archivedCount === 0) setArchived(false);
  }, [archived, archivedCount]);
  const agents = c.agents.filter(
    (agent) =>
      !agent.archived_at && matchesDirectorySearch(agent.name, normalizedSearch),
  );
  const sessions = useMemo(
    () =>
      sortChatSessions(
        c.sessions.filter(
          (session) =>
            (archived
              ? session.status === "archived"
              : session.status !== "archived") &&
            (!agentFilter || session.agent_id === agentFilter) &&
            (matchesDirectorySearch(session.title, normalizedSearch) ||
              matchesDirectorySearch(
                agentById.get(session.agent_id)?.name ?? "",
                normalizedSearch,
              )),
        ),
      ),
    [c.sessions, agentById, agentFilter, archived, normalizedSearch],
  );
  const filteredAgent = agentFilter ? agentById.get(agentFilter) : null;
  const selectAgent = (agent: Agent) => {
    setAgentFilter(agent.id);
    setArchived(false);
    if (c.activeAgent?.id !== agent.id) {
      const recentSession = c.sessions
        .filter(
          (session) =>
            session.agent_id === agent.id && session.status !== "archived",
        )
        .reduce<ChatSession | null>((latest, session) => {
          const activity = (entry: ChatSession) =>
            new Date(entry.last_message?.created_at ?? entry.updated_at).getTime();
          return !latest || activity(session) > activity(latest) ? session : latest;
        }, null);
      if (recentSession) onSelectSession(recentSession);
      else onStartChat(agent);
    }
    setPane("conversation");
  };
  const actionError = () => toast.error(t(($) => $.workbench.session_action_error));
  const canInvoke = Boolean(
    c.activeAgent &&
    c.availableAgents.some((agent) => agent.id === c.activeAgent?.id) &&
    !c.isAgentAccessRevoked,
  );

  return (
    <div
      ref={containerRef}
      className="agent-workspace flex min-h-0 min-w-0 flex-1 flex-col bg-background text-body text-foreground"
      data-pane={pane}
    >
      <PageHeader className="agent-workspace-chrome">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <NavAgentsIcon className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-body font-medium">
            {t(($) => $.workbench.title)}
          </h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          aria-label={t(($) => $.workbench.manage_agents)}
          asChild
        >
          <AppLink href={paths.agents()}>
            <SettingsIcon className="size-3.5" />
            <span className="hidden sm:inline">
              {t(($) => $.workbench.manage_agents)}
            </span>
          </AppLink>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          aria-label={t(($) => $.workbench.all_tasks)}
          asChild
        >
          <AppLink href={paths.issues()}>
            <TaskIcon className="size-3.5" />
            <span className="hidden sm:inline">
              {t(($) => $.workbench.all_tasks)}
            </span>
          </AppLink>
        </Button>
      </PageHeader>
      <div
        className="agent-workspace-mobile-tabs agent-workspace-chrome gap-1 border-b px-3 py-2"
        role="group"
        aria-label={t(($) => $.workbench.panels)}
      >
        <Button
          data-pane-target="directory"
          variant={pane === "directory" ? "secondary" : "ghost"}
          aria-pressed={pane === "directory"}
          size="sm"
          onClick={() => setPane("directory")}
        >
          {t(($) => $.workbench.agents_sessions)}
        </Button>
        <Button
          data-pane-target="conversation"
          variant={pane === "conversation" ? "secondary" : "ghost"}
          aria-pressed={pane === "conversation"}
          size="sm"
          onClick={() => setPane("conversation")}
        >
          {t(($) => $.workbench.conversation)}
        </Button>
        <Button
          data-pane-target="tasks"
          variant={pane === "tasks" ? "secondary" : "ghost"}
          aria-pressed={pane === "tasks"}
          size="sm"
          onClick={() => setPane("tasks")}
        >
          {t(($) => $.workbench.tasks)}
        </Button>
      </div>
      <div className="agent-workspace-columns min-h-0 flex-1">
        <nav
          className="agent-workspace-directory agent-workspace-chrome min-h-0 min-w-0 flex-col overflow-hidden border-r"
          aria-label={t(($) => $.workbench.agents_sessions)}
        >
          <div className="flex h-12 shrink-0 items-center border-b px-3">
            <div className="relative w-full">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="agent-workspace-search"
                aria-label={t(($) => $.workbench.search)}
                placeholder={t(($) => $.workbench.search)}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <div className="flex h-8 items-center justify-between px-2">
              <h2 className="text-caption font-medium text-muted-foreground">
                {t(($) => $.workbench.agents)}
              </h2>
              <Button
                size="icon-xs"
                variant="ghost"
                asChild
                aria-label={t(($) => $.workbench.create_agent)}
              >
                <AppLink href={paths.newAgent()}>
                  <AddIcon className="size-3.5" />
                </AppLink>
              </Button>
            </div>
            {c.agentsLoading && <Spinner size={16} />}
            {c.agentsError && (
              <div role="alert">
                <p>{t(($) => $.workbench.load_error)}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void c.retryAgents()}
                >
                  {t(($) => $.workbench.retry)}
                </Button>
              </div>
            )}
            {agents.map((agent) => {
              const available = c.availableAgents.some(
                (entry) => entry.id === agent.id,
              );
              const hasHistory = c.sessions.some(
                (session) => session.agent_id === agent.id && session.status !== "archived",
              );
              return (
                <div key={agent.id} className="flex items-center gap-1">
                  <Button
                    className="agent-workspace-list-row min-w-0 flex-1 justify-start"
                    variant={
                      agentFilter === agent.id ? "secondary" : "ghost"
                    }
                    aria-pressed={agentFilter === agent.id}
                    title={t(($) => $.workbench.filter_sessions, { name: agent.name })}
                    disabled={!available && !hasHistory}
                    onClick={() => selectAgent(agent)}
                  >
                    <ActorAvatar
                      actorType="agent"
                      actorId={agent.id}
                      size="md"
                      showStatusDot
                      profileLink={false}
                    />
                    <span className="truncate">{agent.name}</span>
                    {!available && (
                      <Badge
                        variant="secondary"
                        className="rounded-full px-2 font-medium"
                      >
                        {t(($) => $.workbench.unavailable)}
                      </Badge>
                    )}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    asChild
                    aria-label={t(($) => $.workbench.configure_agent, {
                      name: agent.name,
                    })}
                  >
                    <AppLink href={paths.agentDetail(agent.id)}>
                      <SettingsIcon className="size-3.5 text-muted-foreground" />
                    </AppLink>
                  </Button>
                </div>
              );
            })}
            {!c.agentsLoading && !c.agentsError && agents.length === 0 && (
              <p className="p-2 text-caption text-muted-foreground">
                {t(($) => $.workbench.no_agents)}
              </p>
            )}
            <div className="mt-3 flex h-10 items-center justify-between gap-1 border-t px-2 pt-2">
              <h2 className="text-caption font-medium text-muted-foreground">
                {t(($) => $.workbench.sessions)}
              </h2>
              <div className="flex items-center gap-1">
                {archivedCount > 0 && (
                  <Button
                    size="xs"
                    variant={archived ? "secondary" : "ghost"}
                    aria-label={t(($) => $.workbench.archived)}
                    aria-pressed={archived}
                    onClick={() => setArchived(!archived)}
                  >
                    {t(($) => $.workbench.archived)}
                    <span className="tabular-nums" aria-hidden="true">{archivedCount}</span>
                  </Button>
                )}
                {c.activeAgent && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={!canInvoke || !c.isAgentRuntimeBound}
                    aria-label={t(($) => $.workbench.new_session)}
                    title={!c.isAgentRuntimeBound ? t(($) => $.window.agent_needs_runtime_hint) : t(($) => $.workbench.new_session)}
                    onClick={() => {
                      if (c.activeAgent) onStartChat(c.activeAgent);
                      setArchived(false);
                      setPane("conversation");
                    }}
                  >
                    <AddIcon className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
            <div className="my-1 flex min-w-0 flex-wrap items-center gap-1 px-1">
              <Button
                size="xs"
                variant={agentFilter === null ? "secondary" : "ghost"}
                aria-pressed={agentFilter === null}
                onClick={() => setAgentFilter(null)}
              >
                {t(($) => $.workbench.all_sessions)}
              </Button>
              {filteredAgent && (
                <Badge variant="secondary" className="max-w-full truncate">{filteredAgent.name}</Badge>
              )}
            </div>
            {c.activeAgent && canInvoke && !c.isAgentRuntimeBound && (
              <p className="px-2 py-1 text-caption text-muted-foreground">
                {t(($) => $.window.agent_needs_runtime_hint)}
              </p>
            )}
            {c.sessionsLoading && <Spinner size={16} />}
            {c.sessionsError && (
              <div role="alert">
                <p>{t(($) => $.workbench.load_error)}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void c.retrySessions()}
                >
                  {t(($) => $.workbench.retry)}
                </Button>
              </div>
            )}
            {sessions.map((session) => (
              <AgentWorkspaceSessionRow
                key={session.id}
                session={session}
                agent={agentById.get(session.agent_id)}
                active={session.id === c.activeSessionId}
                running={pendingSessionIds.has(session.id)}
                offline={presence.byAgent.get(session.agent_id)?.availability === "offline"}
                actionPending={(setPinned.isPending && setPinned.variables?.sessionId === session.id) || (setSessionArchived.isPending && setSessionArchived.variables?.sessionId === session.id)}
                onSelect={() => {
                  onSelectSession(session);
                  setPane("conversation");
                }}
                onTogglePin={() => setPinned.mutate({ sessionId: session.id, pinned: !session.pinned }, { onError: actionError })}
                onArchive={() => onArchive(session)}
                onUnarchive={() => setSessionArchived.mutate({ sessionId: session.id, archived: false }, { onError: actionError })}
              />
            ))}
            {!c.sessionsLoading &&
              !c.sessionsError &&
              sessions.length === 0 && (
                <p className="p-2 text-caption text-muted-foreground">
                  {t(($) => $.workbench.no_sessions)}
                </p>
              )}
          </div>
        </nav>
        <main className="agent-workspace-conversation min-h-0 min-w-0 flex-col">
          {conversation}
        </main>
        <div className="agent-workspace-tasks min-h-0 min-w-0 flex-col border-l">
          <AgentTaskPanel
            wsId={c.wsId}
            agent={c.activeAgent}
            canInvoke={canInvoke}
            sessions={c.sessions}
            canReference={canInvoke && c.isAgentRuntimeBound && !c.isSessionArchived}
            referenceDisabledReason={c.isSessionArchived ? t(($) => $.workbench.reference_read_only) : t(($) => $.workbench.reference_unavailable)}
            onRevealConversation={() => setPane("conversation")}
            onReference={(issue) => {
              onReference(issue);
              setPane("conversation");
            }}
          />
        </div>
      </div>
    </div>
  );
}
