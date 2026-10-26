"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from "@multica/ui/components/ui/input-group";
import { useIsCompact } from "@multica/ui/hooks/use-mobile";
import { useAuthStore } from "@multica/core/auth";
import { isAgentRuntimeBound } from "@multica/core/agents";
import { canAssignAgentToIssue } from "@multica/core/permissions";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { chatSessionsOptions, sortChatSessions } from "@multica/core/chat/queries";
import { useCreateChatSession, useMarkChatSessionRead, useSetChatSessionArchived } from "@multica/core/chat/mutations";
import type { Agent, ChatSession } from "@multica/core/types";
import { useCurrentWorkspace, useRequiredWorkspaceSlug, useWorkspacePaths } from "@multica/core/paths";
import { getCurrentSlug } from "@multica/core/platform";
import { useNavigation } from "../navigation";
import { useAppForeground } from "../common/use-app-foreground";
import { useChatDraftRestore } from "../chat/components/use-chat-draft-restore";
import { ChatThreadList } from "../chat/components/chat-thread-list";
import { ChatSessionHeader } from "../chat/components/chat-session-header";
import { ActorAvatar } from "../common/actor-avatar";
import { PageHeader } from "../layout/page-header";
import { useT } from "../i18n";
import { TuttiAgentGuiPanel } from "./tutti-agent-gui-panel";

/** Selection belongs to this tab's URL, never the native chat's active pointer. */
export function ConversationFlowPage() {
  const workspaceSlug = useRequiredWorkspaceSlug();
  const workspace = useCurrentWorkspace();
  const paths = useWorkspacePaths();
  const userId = useAuthStore((state) => state.user?.id);
  const { pathname, searchParams, replace, push, openInNewTab } = useNavigation();
  const foreground = useAppForeground();
  const { t } = useT("chat");
  const compact = useIsCompact();
  const [showCompactList, setShowCompactList] = useState(false);
  const [search, setSearch] = useState("");
  // Successful creation reveals history and focuses the new composer.
  const [newConversationSequence, setNewConversationSequence] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const active = pathname === paths.conversationFlow() && getCurrentSlug() === workspaceSlug;
  const conversationVisible = active && (!compact || !showCompactList);
  const sessionId = searchParams.get("session") || null;
  const agentId = searchParams.get("agent") || null;
  const currentSelection = useRef(sessionId);
  currentSelection.current = sessionId;
  const currentPath = useRef(pathname);
  currentPath.current = pathname;
  const selectionIntent = useRef(0);
  const workspaceId = workspace?.id ?? "";
  const sessionsQuery = useQuery({ ...chatSessionsOptions(workspaceId), enabled: !!workspace && !!userId });
  const agentsQuery = useQuery({ ...agentListOptions(workspaceId), enabled: !!workspace && !!userId });
  const membersQuery = useQuery({ ...memberListOptions(workspaceId), enabled: !!workspace && !!userId });
  const createSession = useCreateChatSession();
  const archiveSession = useSetChatSessionArchived();
  const { mutate: markRead } = useMarkChatSessionRead();
  const lastReadAttempt = useRef<string | null>(null);
  const sessions = sessionsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const session = sessions.find((item) => item.id === sessionId);
  const agent = agents.find((item) => item.id === (session?.agent_id ?? agentId));
  const role = membersQuery.data?.find((member) => member.user_id === userId)?.role;
  const availableAgents = membersQuery.isSuccess ? agents.filter((item) => !item.archived_at && isAgentRuntimeBound(item)
    && canAssignAgentToIssue(item, { userId: userId ?? null, role: role === "owner" || role === "admin" || role === "member" ? role : null }).allowed) : [];
  const newAgent = availableAgents.find((item) => item.id === agent?.id) ?? availableAgents[0];
  const { restoreDraftRequest, handleRestoreDraftApplied } = useChatDraftRestore(sessionId, conversationVisible && foreground && !!workspace && !!userId);

  useEffect(() => {
    if (!conversationVisible || !foreground) {
      lastReadAttempt.current = null;
      return;
    }
    if (!session || !(session.has_unread || (session.unread_count ?? 0) > 0)) return;
    const stamp = `${session.id}:${session.last_message?.created_at ?? session.updated_at}`;
    if (lastReadAttempt.current === stamp) return;
    lastReadAttempt.current = stamp;
    markRead(session.id);
  }, [conversationVisible, foreground, session, markRead]);

  const selectSession = (selected: ChatSession | null, selectedAgent?: Agent) => {
    if (getCurrentSlug() !== workspaceSlug || currentPath.current !== paths.conversationFlow()) return;
    selectionIntent.current++;
    const target = selected ? paths.conversationFlowSession(selected.id)
      : selectedAgent ? paths.conversationFlowWithAgent(selectedAgent.id) : paths.conversationFlow();
    if (`${pathname}${searchParams.size ? `?${searchParams}` : ""}` !== target) replace(target);
    setShowCompactList(false);
  };

  const advanceSelection = (removedId: string) => {
    if (currentSelection.current !== removedId) return;
    selectSession(sortChatSessions(sessions.filter((item) => item.id !== removedId && item.status !== "archived"))[0] ?? null);
  };

  const onArchive = (selected: ChatSession) => archiveSession.mutate({ sessionId: selected.id, archived: true }, {
    onSuccess: () => advanceSelection(selected.id),
    onError: () => toast.error(t(($) => $.workbench.session_action_error)),
  });

  if (!workspace || !userId) return null;

  const backToList = compact ? <IconButton label={t(($) => $.workbench.sessions)} onClick={() => setShowCompactList(true)}><ArrowLeft /></IconButton> : undefined;
  const clearSearch = () => { setSearch(""); searchInput.current?.focus(); };

  const conversation = <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="conversation-flow-detail">
    {session ? <ChatSessionHeader session={session} agent={agent ?? null} onArchive={onArchive} onDeletedSession={advanceSelection} leading={backToList} />
      : <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        {backToList}
        {agent && <ActorAvatar actorType="agent" actorId={agent.id} size="lg" enableHoverCard showStatusDot />}
        <span className="truncate text-body font-medium">{agent?.name ?? t(($) => $.workbench.new_session)}</span>
      </div>}
    <TuttiAgentGuiPanel
    key={`${workspace.id}:${userId}`}
    workspaceId={workspace.id}
    workspaceSlug={workspaceSlug}
    userId={userId}
    activeSessionId={sessionId}
    selectedAgentId={agentId}
    active={conversationVisible}
    composerFocusSequence={newConversationSequence || undefined}
    restoreDraftRequest={restoreDraftRequest}
    onRestoreDraftApplied={handleRestoreDraftApplied}
    onSelectSession={selectSession}
    onOpenTask={(issueId) => {
      const target = paths.issueDetail(issueId);
      if (openInNewTab) openInNewTab(target, undefined, { activate: true });
      else push(target);
    }}
    onShowMessage={(message, tone) => tone === "error" ? toast.error(message)
      : tone === "warning" ? toast.warning(message) : toast.info(message)}
  /></div>;

  const list = <div className="flex h-full min-h-0 flex-col border-r" data-testid="conversation-flow-sessions">
    <PageHeader>
      <h1 className="min-w-0 flex-1 truncate text-body font-semibold">{t(($) => $.workbench.sessions)}</h1>
      {compact && <IconButton label={t(($) => $.workbench.return_conversation)} onClick={() => setShowCompactList(false)}><ArrowRight /></IconButton>}
      <IconButton className="rounded-full text-muted-foreground" label={t(($) => $.workbench.new_session)}
        disabled={!newAgent || createSession.isPending}
        disabledReason={!newAgent ? t(($) => $.workbench.new_session_unavailable) : undefined}
        aria-busy={createSession.isPending || undefined}
        onClick={() => {
          if (!newAgent) return;
          const intent = ++selectionIntent.current;
          createSession.mutate({ agent_id: newAgent.id }, {
            onSuccess: (created) => {
              if (selectionIntent.current !== intent || currentSelection.current !== sessionId
                || currentPath.current !== paths.conversationFlow() || getCurrentSlug() !== workspaceSlug) return;
              setSearch("");
              setNewConversationSequence((sequence) => sequence + 1);
              selectSession(created);
            },
            onError: () => toast.error(t(($) => $.workbench.session_action_error)),
          });
        }}>{createSession.isPending ? <Loader2 className="animate-spin" /> : <Plus />}</IconButton>
    </PageHeader>
    <div className="shrink-0 px-3 pb-1 pt-3">
      <InputGroup>
        <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
        <InputGroupInput ref={searchInput} value={search} aria-label={t(($) => $.workbench.search_sessions)} placeholder={t(($) => $.workbench.search_sessions)}
          onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); clearSearch(); } }} />
        {search && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label={t(($) => $.workbench.clear_search)} onClick={clearSearch}><X /></InputGroupButton></InputGroupAddon>}
      </InputGroup>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
      {sessionsQuery.isPending || agentsQuery.isPending || membersQuery.isPending ? <p className="px-3 py-4 text-body text-muted-foreground" role="status">{t(($) => $.workbench.loading)}</p>
        : sessionsQuery.isError || agentsQuery.isError || membersQuery.isError ? <div className="flex flex-col items-center gap-3 p-4" role="alert">
          <span className="text-body text-muted-foreground">{t(($) => $.workbench.load_error)}</span>
          <Button variant="outline" onClick={() => { void sessionsQuery.refetch(); void agentsQuery.refetch(); void membersQuery.refetch(); }}>{t(($) => $.workbench.retry)}</Button>
        </div> : <ChatThreadList key={newConversationSequence} sessions={sessions} agents={agents} activeSessionId={sessionId}
          searchQuery={search}
          emptyContent={search.trim() ? <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
          <Search className="size-5 text-faint-foreground" aria-hidden="true" />
          <p className="text-body text-muted-foreground" role="status">{t(($) => $.workbench.no_search_results)}</p>
          <Button variant="ghost" size="sm" onClick={clearSearch}>{t(($) => $.workbench.clear_search)}</Button>
          </div> : undefined}
          onSelectSession={selectSession} onArchive={onArchive} onDeletedSession={advanceSelection}
          getSessionHref={(id) => paths.conversationFlowSession(id)} />}
    </div>
  </div>;

  return <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[minmax(260px,min(28%,360px))_minmax(0,1fr)]" data-testid="conversation-flow-page">
    <div className="h-full min-h-0" hidden={compact && !showCompactList}>{list}</div>
    <div className="h-full min-h-0 min-w-0" hidden={compact && showCompactList}>{conversation}</div>
  </div>;
}
