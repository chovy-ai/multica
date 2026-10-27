import type { LocalConversation, LocalFolderProject } from "@multica/core/local-conversation/protocol";

export interface LocalConversationProjectGroup {
  id: string | null;
  project?: LocalFolderProject;
  sessions: LocalConversation[];
}

function directoryKey(path: string): string { return path.replace(/[/\\]+$/, "") || path; }

export function projectForDirectory(projects: LocalFolderProject[], cwd: string): LocalFolderProject | undefined {
  return projects.find((project) => directoryKey(project.path) === directoryKey(cwd));
}

/** Local folder projects follow execution directories; cloud task associations stay independent. */
export function groupLocalConversations(sessions: LocalConversation[], projects: LocalFolderProject[], archived: boolean, search: string): LocalConversationProjectGroup[] {
  const catalog = new Map(projects.map((project) => [directoryKey(project.path), project]));
  const groups = new Map<string | null, LocalConversationProjectGroup>();
  const query = search.toLocaleLowerCase().trim();
  for (const session of sessions) {
    if (session.archived !== archived) continue;
    const project = catalog.get(directoryKey(session.cwd)), id = project?.id ?? null;
    if (query && ![session.title, session.messages.at(-1)?.content, project?.title, project?.path].some((value) => value?.toLocaleLowerCase().includes(query))) continue;
    let group = groups.get(id);
    if (!group) { group = { id, project, sessions: [] }; groups.set(id, group); }
    group.sessions.push(session);
  }
  const result: LocalConversationProjectGroup[] = [];
  for (const project of projects) {
    const group = groups.get(project.id);
    if (group) { result.push(group); groups.delete(project.id); }
    else if (!archived && !query) result.push({ id: project.id, project, sessions: [] });
  }
  const unassigned = groups.get(null);
  if (unassigned) result.push(unassigned);
  else if (!query && result.length) result.push({ id: null, sessions: [] });
  return result;
}
