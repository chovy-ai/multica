// @vitest-environment node
import { expect, it } from "vitest";
import { resolveResourceReference } from "./resource-reference";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = { workspaceId: "workspace", workspaceSlug: "acme", appOrigin: "https://app.example.test" };

it.each([
  ["agents", "agent"], ["issues", "issue"], ["projects", "project"], ["squads", "squad"],
  ["skills", "skill"], ["autopilots", "autopilot"], ["runtimes", "runtime"],
])("resolves %s links and scoped mentions to the same resource", (route, kind) => {
  for (const href of [`https://app.example.test/acme/${route}/${id}`, `/acme/${route}/${id}`, `/${route}/${id}`, `mention://${kind}/${id}?workspaceId=workspace`]) {
    expect(resolveResourceReference(href, scope)).toEqual({ kind, id, path: `/acme/${route}/${id}`, mentionHref: `mention://${kind}/${id}?workspaceId=workspace` });
  }
});

it("recognizes existing task and agent mention providers and human task keys", () => {
  expect(resolveResourceReference(`mention://agent-target/${id}?workspaceId=workspace&agentProviderId=codex`, scope)?.kind).toBe("agent");
  expect(resolveResourceReference("mention://workspace-issue/TES-124?workspaceId=workspace", scope)).toMatchObject({ kind: "issue", id: "TES-124", path: "/acme/issues/TES-124" });
  expect(resolveResourceReference("/acme/issues/TES-124#comment-1", scope)?.path).toBe("/acme/issues/TES-124#comment-1");
  expect(resolveResourceReference(`/acme/agents/${id}?view=general#avatar`, scope)?.path).toBe(`/acme/agents/${id}?view=general#avatar`);
});

it.each([
  `https://other.example/acme/agents/${id}`, `https://app.example.test.evil.test/acme/agents/${id}`,
  `https://user:secret@app.example.test/acme/agents/${id}`, `//other.example/acme/issues/${id}`,
  `/\\other.example/acme/issues/${id}`, `/other/agents/${id}`, `mention://agent/${id}?workspaceId=other`,
  `/acme/agents/new`, `/acme/agents/${id}/settings`, `/acme/agents/${id}%2Fmore`,
  `/acme/agents/%zz`, "/acme/issues/not-a-task", "/acme/agents/", "javascript:alert(1)",
  `mention://agent-target/${id}/more`, "mention://workspace-issue/multica:create-task?workspaceId=workspace",
])("leaves non-resource or foreign links alone: %s", (href) => {
  expect(resolveResourceReference(href, scope)).toBeNull();
});

it("needs a configured origin for absolute URLs but can resolve local paths and mentions without one", () => {
  const local = { workspaceId: scope.workspaceId, workspaceSlug: scope.workspaceSlug };
  expect(resolveResourceReference(`https://app.example.test/acme/agents/${id}`, local)).toBeNull();
  expect(resolveResourceReference(`https://multica-link.invalid/acme/agents/${id}`, local)).toBeNull();
  expect(resolveResourceReference(`/acme/agents/${id}`, local)?.id).toBe(id);
  expect(resolveResourceReference(`mention://agent/${id}`, local)?.id).toBe(id);
});
