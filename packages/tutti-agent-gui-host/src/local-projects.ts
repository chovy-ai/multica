import type { AgentGuiWorkspaceState } from "./protocol";

export function isAutomaticLocalDirectory(path: string): boolean {
  return /(?:^|[\\/])local-conversations[\\/](?:[a-f0-9]{64}[\\/]workdirs|workdirs[\\/]\d+)[\\/][^\\/]+[\\/]?$/.test(path);
}

export function localProjectSectionKey(path: string): string {
  return `local-project:${path}`;
}

/** The folder catalog and explicitly selected session directories share one picker. */
export function localGuiProjects(state: AgentGuiWorkspaceState) {
  const projects = new Map((state.folderProjects ?? []).map((project) => [project.path, {
    id: project.id, path: project.path, label: project.title,
    sectionKey: localProjectSectionKey(project.path), pinnedAtUnixMs: 0,
  }]));
  for (const session of state.sessions) {
    const path = session.localDirectory?.projectPath;
    if (path && !projects.has(path)) projects.set(path, {
      id: localProjectSectionKey(path), path, label: path.split(/[\\/]/).filter(Boolean).at(-1) || path,
      sectionKey: localProjectSectionKey(path), pinnedAtUnixMs: 0,
    });
  }
  return [...projects.values()];
}
