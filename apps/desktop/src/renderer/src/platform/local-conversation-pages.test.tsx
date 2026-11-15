import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ConversationListModel } from "@multica/conversation-client/models";
import { localV2SummarySchema } from "@multica/core/local-conversation/v2";
import { observer } from "mobx-react-lite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConversationOrderStore } from "../stores/local-conversation-order-store";
import type { LocalSessionEntry } from "./local-conversation-projects";
import { useLocalConversationPages } from "./local-conversation-pages";

const fixture = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./conversation-services", () => ({ conversationService: () => fixture.client }));
vi.mock("@multica/core/api", () => ({ api: { getBaseUrl: () => "https://api.test" } }));
afterEach(cleanup);
beforeEach(() => useConversationOrderStore.setState({ ordersByScope: {} }));

const summary = (id: string, seq = 1, title = id) => localV2SummarySchema.parse({
  conversation_id: id, summary_seq: seq, provider: "codex", title, status: "idle", pinned: false,
  archived: false, turn_count: 1, updated_at: "2026-11-04T00:00:00Z",
});

it("orders before pagination and retains the complete group through archive filtering, refresh and remount", async () => {
  const list = new ConversationListModel();
  list.upsert(Array.from({ length: 10 }, (_, index) => ({ ...summary(String(index)), cwd: "/project", archived: index === 3 })));
  list.upsert([{ ...summary("outside"), cwd: "/elsewhere" }]);
  fixture.client = { list, loadSummaries: vi.fn(async () => {}) };
  const transport = { availability: () => ({ state: "connected" }), onAvailability: () => () => {}, onConnection: () => () => {} } as unknown as Parameters<typeof useLocalConversationPages>[0];
  const scope = { userId: "user", workspaceId: "workspace" };
  const projects = [{ id: "project", path: "/project", title: "Project", createdAt: "2026-11-04T00:00:00Z" }];
  let page: ReturnType<typeof useLocalConversationPages>;
  const Page = observer(({ archived = false, search = "" }: { archived?: boolean; search?: string }) => {
    page = useLocalConversationPages(transport, scope, projects, [], archived, search, true);
    return <>{page.groups.map((group) => <div key={group.id}>{group.sessions.map((item) => item.id).join(",")}</div>)}</>;
  });
  const app = render(<Page />);
  await waitFor(() => expect(page!.isPending).toBe(false));
  expect(page!.groups[0]!.sessions.map((item) => item.id)).toEqual(["0", "1", "2", "4", "5", "6", "7", "8"]);
  act(() => page!.reorder("project", "8", "0"));
  expect(page!.groups[0]!.sessions.map((item) => item.id)).toEqual(["8", "0", "1", "2", "4", "5", "6", "7"]);
  act(() => page!.reorder("project", "outside", "0"));
  expect(page!.groups[0]!.sessions[0]!.id).toBe("8");
  app.rerender(<Page archived />);
  expect(page!.groups[0]!.sessions.map((item) => item.id)).toEqual(["3"]);
  app.rerender(<Page search="8" />);
  expect(page!.groups[0]!.sessions.map((item) => item.id)).toEqual(["8"]);
  app.rerender(<Page />);
  act(() => list.upsert([{ ...summary("6", 2), cwd: "/project", last_turn_sent_at: "2026-11-15T00:00:00Z" }]));
  expect(page!.groups[0]!.sessions[0]!.id).toBe("8");
  act(() => list.upsert([{ ...summary("new"), cwd: "/project", last_turn_sent_at: "2026-11-16T00:00:00Z" }]));
  expect(page!.groups[0]!.sessions[0]!.id).toBe("new");
  await act(() => page!.loadMore(page!.groups[0]!));
  expect(page!.groups[0]!.sessions.map((item) => item.id)).toEqual(["new", "8", "0", "1", "2", "4", "5", "6", "7", "9"]);
  app.unmount();
  render(<Page />);
  expect(page!.groups[0]!.sessions.map((item) => item.id)).toEqual(["new", "8", "0", "1", "2", "4", "5", "6"]);
});

it("keeps unrelated row props stable across selection and summary updates", async () => {
  const list = new ConversationListModel();
  list.upsert([summary("a"), summary("b"), summary("c")]);
  fixture.client = { list, loadSummaries: vi.fn(async () => {}) };
  const renders = new Map<string, number>();
  const Row = observer(({ entry, selected }: { entry: LocalSessionEntry; selected: boolean }) => {
    renders.set(entry.id, (renders.get(entry.id) ?? 0) + 1);
    return <div aria-current={selected}>{entry.title}</div>;
  });
  const transport = {
    availability: () => ({ state: "connected" }),
    onAvailability: () => () => {}, onConnection: () => () => {},
  } as unknown as Parameters<typeof useLocalConversationPages>[0];
  const scope = { userId: "user", workspaceId: "workspace" };
  const projects: Parameters<typeof useLocalConversationPages>[2] = [];
  const hidden: string[] = [];
  let loaded = false;
  let pageRenders = 0;
  const Page = observer(({ selected }: { selected: string }) => {
    pageRenders++;
    const page = useLocalConversationPages(transport, scope, projects, hidden, false, "", true);
    loaded = !page.isPending;
    return <>{page.data.map((entry) => <Row key={entry.id} entry={entry} selected={selected === entry.id} />)}</>;
  });
  const app = render(<Page selected="a" />);
  await waitFor(() => expect(loaded).toBe(true));
  renders.clear();
  app.rerender(<Page selected="b" />);
  expect(Object.fromEntries(renders)).toEqual({ a: 1, b: 1 });
  renders.clear();
  act(() => list.upsert([summary("a", 2, "Renamed")]));
  expect(Object.fromEntries(renders)).toEqual({ a: 1 });
  renders.clear();
  const before = pageRenders;
  act(() => list.upsert([summary("a", 3, "Renamed")]));
  expect(pageRenders).toBe(before);
  expect(renders.size).toBe(0);
});
