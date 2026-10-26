import { paths } from "@multica/core/paths";

export interface ResourceLinkScope { workspaceId: string; workspaceSlug: string; appOrigin?: string | null }
export type ResourceKind = "agent" | "issue" | "project" | "squad" | "skill" | "autopilot" | "runtime";
export interface ResourceReference { kind: ResourceKind; id: string; path: string; mentionHref: string }

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const issueKey = /^[A-Z0-9]{1,10}-[1-9][0-9]*$/;
const routes: Record<string, ResourceKind> = { agents: "agent", issues: "issue", projects: "project", squads: "squad", skills: "skill", autopilots: "autopilot", runtimes: "runtime" };
const mentions: Record<string, ResourceKind> = { agent: "agent", "agent-target": "agent", issue: "issue", "workspace-issue": "issue", project: "project", squad: "squad", skill: "skill", autopilot: "autopilot", runtime: "runtime" };

/** Only links owned by this deployment and workspace become internal references. */
export function resolveResourceReference(href: string, scope: ResourceLinkScope): ResourceReference | null {
  try {
    if (!href.trim() || href.includes("\\") || [...href].some((character) => character.charCodeAt(0) < 32)) return null;
    const base = scope.appOrigin ? new URL(scope.appOrigin) : new URL("https://multica-link.invalid");
    const target = new URL(href, base);
    if (target.username || target.password) return null;
    let kind: ResourceKind | undefined;
    let id: string | undefined;
    let suffix = "";
    const segments = target.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (target.protocol === "mention:") {
      kind = mentions[target.hostname];
      if (segments.length !== 1) return null;
      id = segments[0];
      const workspaceId = target.searchParams.get("workspaceId");
      if (workspaceId && workspaceId !== scope.workspaceId) return null;
    } else {
      if (!scope.appOrigin && !href.trim().startsWith("/")) return null;
      if (!scope.appOrigin && href.trim().startsWith("//")) return null;
      if (!["http:", "https:"].includes(target.protocol) || target.origin !== base.origin) return null;
      if (segments.length === 3 && segments[0] === scope.workspaceSlug) {
        kind = routes[segments[1]!]; id = segments[2];
      } else if (segments.length === 2) {
        kind = routes[segments[0]!]; id = segments[1];
      }
      suffix = target.search + target.hash;
    }
    if (!kind || !id || !(uuid.test(id) || kind === "issue" && issueKey.test(id))) return null;
    const workspacePaths = paths.workspace(scope.workspaceSlug);
    const build = { agent: workspacePaths.agentDetail, issue: workspacePaths.issueDetail, project: workspacePaths.projectDetail, squad: workspacePaths.squadDetail, skill: workspacePaths.skillDetail, autopilot: workspacePaths.autopilotDetail, runtime: workspacePaths.runtimeDetail }[kind];
    return { kind, id, path: build(id) + suffix,
      mentionHref: `mention://${kind}/${encodeURIComponent(id)}?${new URLSearchParams({ workspaceId: scope.workspaceId })}` };
  } catch { return null; }
}
