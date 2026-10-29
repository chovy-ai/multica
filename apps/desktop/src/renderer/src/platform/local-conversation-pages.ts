import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LocalConversation, LocalConversationClient, LocalConversationScope, LocalFolderProject } from "@multica/core/local-conversation/protocol";
import { localConversationKey } from "./local-conversation-service";

export interface ConversationPageGroup {
  id: string | null;
  project?: LocalFolderProject;
  sessions: LocalConversation[];
  nextCursor: string | null;
  pageCount: number;
}
export function useLocalConversationPages(client: LocalConversationClient, scope: LocalConversationScope, projects: LocalFolderProject[], hidden: string[], archived: boolean, search: string, enabled: boolean) {
  const qc = useQueryClient();
  const queryKey = [...localConversationKey(scope), "pages", projects.map(({ id, path }) => [id, path]), [...hidden].sort(), archived, search.trim()];
  const pending = useRef(new Set<string | null>());
  const [loading, setLoading] = useState(new Set<string | null>());
  const query = useQuery({ queryKey, enabled, refetchOnMount: "always", queryFn: async () => {
    const previous = qc.getQueryData<ConversationPageGroup[]>(queryKey);
    return Promise.all([...projects.filter((project) => !hidden.includes(project.id)).map((project) => ({ id: project.id as string | null, project })), { id: null, project: undefined }].map(async ({ id, project }) => {
      const pageCount = previous?.find((group) => group.id === id)?.pageCount ?? 1;
      const sessions = new Map<string, LocalConversation>();
      let cursor: string | undefined;
      let count = 0;
      do {
        const page = await client.request(scope, "listPage", { folderProjectId: id, archived, search: search.trim(), cursor });
        page.sessions.forEach((entry) => sessions.set(entry.id, entry));
        cursor = page.nextCursor ?? undefined;
        count++;
      } while (cursor && count < pageCount);
      return { id, project, sessions: [...sessions.values()], nextCursor: cursor ?? null, pageCount: count };
    }));
  } });
  const loadMore = async (group: ConversationPageGroup) => {
    if (!group.nextCursor || pending.current.has(group.id) || query.isFetching) return;
    pending.current.add(group.id); setLoading(new Set(pending.current));
    try {
      const page = await client.request(scope, "listPage", { folderProjectId: group.id, archived, search: search.trim(), cursor: group.nextCursor });
      qc.setQueryData<ConversationPageGroup[]>(queryKey, (groups) => groups?.map((current) => {
        // A refresh may have replaced this cursor while the click was in flight.
        if (current.id !== group.id || current.nextCursor !== group.nextCursor) return current;
        const sessions = new Map(current.sessions.map((entry) => [entry.id, entry]));
        page.sessions.forEach((entry) => sessions.set(entry.id, entry));
        return { ...current, sessions: [...sessions.values()], nextCursor: page.nextCursor, pageCount: current.pageCount + 1 };
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes("Conversation list changed or expired")) await qc.invalidateQueries({ queryKey, exact: true });
      throw error;
    } finally { pending.current.delete(group.id); setLoading(new Set(pending.current)); }
  };
  const groups = (query.data ?? []).filter((group) => group.sessions.length || (!archived && !search.trim() && (group.id !== null || projects.length > 0)));
  return { ...query, data: query.data?.flatMap((group) => group.sessions), groups, loading, loadMore };
}
