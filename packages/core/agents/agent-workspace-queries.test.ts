// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import type { Issue, ListIssuesResponse } from "../types";
import { onIssueUpdated } from "../issues/ws-updaters";
import { agentWorkspaceIssuesOptions } from "./queries";

const clients: QueryClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.clear()));

describe("Agent workspace assigned tasks", () => {
  it("pages the server's exact Agent assignment and reconciles a reassignment through existing Issue events", async () => {
    const issue = {
      id: "issue-1",
      title: "Review build",
      status: "todo",
      priority: "none",
      assignee_type: "agent",
      assignee_id: "agent-1",
      project_id: null,
      parent_issue_id: null,
      revision: 1,
    } as Issue;
    const listIssues = vi
      .fn()
      .mockResolvedValueOnce({ issues: [issue], total: 2 })
      .mockResolvedValueOnce({
        issues: [{ ...issue, id: "issue-2" }],
        total: 2,
      });
    setApiInstance({ listIssues } as unknown as ApiClient);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const options = agentWorkspaceIssuesOptions("workspace-1", "agent-1");
    const observer = new InfiniteQueryObserver(client, options);
    await observer.refetch();
    await observer.fetchNextPage();
    expect(listIssues.mock.calls).toEqual([
      [
        {
          assignee_id: "agent-1",
          assignee_types: ["agent"],
          limit: 30,
          offset: 0,
        },
      ],
      [
        {
          assignee_id: "agent-1",
          assignee_types: ["agent"],
          limit: 30,
          offset: 1,
        },
      ],
    ]);
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
    onIssueUpdated(
      client,
      "workspace-1",
      { ...issue, assignee_id: "agent-2", revision: 2 },
      { assigneeChanged: true },
    );
    expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
    listIssues.mockResolvedValue({
      issues: [{ ...issue, id: "issue-2" }],
      total: 1,
    });
    await observer.refetch();
    const data = client.getQueryData<{ pages: ListIssuesResponse[] }>(
      options.queryKey,
    );
    expect(
      data?.pages.flatMap((page) => page.issues).map((row) => row.id),
    ).toEqual(["issue-2"]);
  });

  it("keeps Agent and Workspace results separate and stops if a page is empty despite an outdated total", async () => {
    const listIssues = vi.fn().mockResolvedValue({ issues: [], total: 50 });
    setApiInstance({ listIssues } as unknown as ApiClient);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    const first = agentWorkspaceIssuesOptions("workspace-1", "agent-1");
    await client.fetchInfiniteQuery(first);
    const second = agentWorkspaceIssuesOptions("workspace-2", "agent-1");
    expect(client.getQueryData(second.queryKey)).toBeUndefined();
    const otherAgent = agentWorkspaceIssuesOptions("workspace-1", "agent-2");
    expect(client.getQueryData(otherAgent.queryKey)).toBeUndefined();
    const observer = new InfiniteQueryObserver(client, first);
    await observer.fetchNextPage();
    expect(listIssues).toHaveBeenCalledTimes(1);
  });
});
