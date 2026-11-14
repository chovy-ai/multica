import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import type { AgentRuntime } from "@multica/core/types";
import enAgents from "../../../locales/en/agents.json";
import enCommon from "../../../locales/en/common.json";
import { formatMemoryDocument, parseMemoryDocument } from "./memory-document";
import { AgentMemoryPane } from "./agent-memory-pane";
import {
  AgentMemoryConflictError,
  type AgentMemoryAdapter,
  type AgentMemoryEntry,
  type AgentMemoryTree,
} from "./types";

const daemon = vi.hoisted(() => ({
  daemonId: "local",
  deviceName: "This computer",
  running: true,
}));
vi.mock("../../../platform", () => ({ useLocalDaemonStatus: () => daemon }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace" }));
vi.mock("../../../editor/readonly-content", () => ({
  ReadonlyContent: ({ content }: { content: string }) => (
    <div data-testid="readonly">{content}</div>
  ),
}));
// Browser tests cover Pierre's shadow DOM, virtual scrolling and keyboard behavior.
// These pane tests exercise the adapter/editor wiring through file selections.
vi.mock("./memory-file-tree", () => ({
  MemoryFileTree: ({
    tree,
    selection,
    onSelect,
  }: {
    tree: AgentMemoryTree;
    selection: import("./memory-tree").MemorySelection;
    onSelect: (selection: import("./memory-tree").MemorySelection) => void;
  }) => (
    <div role="tree" aria-label="Memory files">
      <button
        role="treeitem"
        aria-selected={selection.type === "index"}
        title="Generated · Read only"
        onClick={() => onSelect({ type: "index" })}
      >
        MEMORY.md
      </button>
      {tree.entries.map((entry) => (
        <button
          key={entry.path}
          role="treeitem"
          onClick={() => onSelect({ type: "entry", path: entry.path })}
        >
          {entry.path}
        </button>
      ))}
      {tree.trash.map((entry) => (
        <button
          key={entry.trashPath}
          role="treeitem"
          onClick={() => onSelect({ type: "trash", path: entry.trashPath })}
        >
          {entry.trashPath}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./memory-code-editor", () => ({
  MemoryCodeEditor: ({
    value,
    onChange,
    label,
    readOnly,
    markers = [],
  }: import("./memory-code-editor").MemoryCodeEditorProps) => (
    <textarea
      aria-label={label}
      value={value}
      readOnly={readOnly}
      aria-invalid={markers.some((m) => m.severity === "error")}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));
const first: AgentMemoryEntry = {
  path: "feedback/root-cause.md",
  title: "Root cause first",
  description: "Find evidence",
  kind: "feedback",
  projectDir: "",
  createdAt: "2026-11-14T00:00:00Z",
  updatedAt: "2026-11-14T00:00:00Z",
  source: "CHOV-117",
  body: "Why: observed failure",
};
const second: AgentMemoryEntry = {
  ...first,
  path: "project/general/plan.md",
  projectDir: "general",
  kind: "project",
  title: "Plan first",
};
function adapter(): AgentMemoryAdapter {
  let entries = [first, second];
  let trash: AgentMemoryTree["trash"] = [];
  return {
    tree: vi.fn(async () => ({
      exists: true,
      root: "/profile/agents/id/memory",
      index: "# Memory\n## feedback",
      entries,
      projects: [{ dir: "general", title: "general" }],
      trash,
    })),
    read: vi.fn(
      async (_id, path) => entries.find((e) => e.path === path) ?? first,
    ),
    readTrash: vi.fn(async () => first),
    search: vi.fn(async () => [
      { path: first.path, title: "Search hit", snippet: "Found evidence" },
    ]),
    update: vi.fn(async (_id, input) => {
      const parsed = parseMemoryDocument(input.document, first);
      const entry = {
        ...first,
        title: parsed.title,
        description: parsed.description,
        body: parsed.body,
        updatedAt: "2026-11-14T00:00:01Z",
      };
      entries = entries.map((e) => (e.path === entry.path ? entry : e));
      return { entry, warnings: [] };
    }),
    remove: vi.fn(async (_id, path) => {
      entries = entries.filter((e) => e.path !== path);
      trash = [
        {
          trashPath: "20261114T000000Z/" + path,
          originalPath: path,
          title: first.title,
          deletedAt: "2026-11-14T00:00:00Z",
        },
      ];
    }),
    restore: vi.fn(async () => {
      entries = [...entries, first];
      trash = [];
      return first;
    }),
    clear: vi.fn(async () => {
      entries = [];
    }),
  };
}
function mount(
  a: AgentMemoryAdapter | undefined,
  canEdit = true,
  runtimeId = "local",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <I18nProvider
      locale="en"
      resources={{ en: { agents: enAgents, common: enCommon } }}
    >
      <QueryClientProvider client={client}>
        <AgentMemoryPane
          agentId="agent"
          runtime={
            {
              id: "runtime",
              daemon_id: runtimeId,
              provider: "claude",
              name: "Claude (Other device)",
            } as AgentRuntime
          }
          adapter={a}
          canEdit={canEdit}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}
beforeEach(() => {
  daemon.daemonId = "local";
  daemon.running = true;
});
describe("agent memory", () => {
  it("explains desktop-only availability without querying", () => {
    mount(undefined);
    expect(screen.getByText(/View memory in the desktop app/)).toBeVisible();
  });
  it("explains another device without reading local memory", () => {
    const a = adapter();
    mount(a, true, "remote");
    expect(screen.getByText(/Memory is stored on/)).toBeVisible();
    expect(a.tree).not.toHaveBeenCalled();
  });
  it("explains when the owning daemon is stopped", () => {
    daemon.running = false;
    const a = adapter();
    mount(a);
    expect(screen.getByText(/local daemon is not running/)).toBeVisible();
    expect(a.tree).not.toHaveBeenCalled();
  });
  it("renders the generated index read-only and saves with the original version", async () => {
    const a = adapter();
    mount(a);
    expect(
      await screen.findByRole("treeitem", { name: "MEMORY.md" }),
    ).toHaveAttribute("title", "Generated · Read only");
    expect(
      screen.getByRole("textbox", { name: "Markdown document" }),
    ).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("treeitem", { name: first.path }));
    const title = await screen.findByRole("textbox", {
      name: "Markdown document",
    });
    fireEvent.change(title, {
      target: {
        value: formatMemoryDocument({ ...first, title: "Updated title" }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(a.update).toHaveBeenCalledWith(
        "agent",
        expect.objectContaining({
          expectedUpdatedAt: first.updatedAt,
          document: expect.stringContaining("title: Updated title"),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
    );
  });
  it("reloads the latest content after a version conflict", async () => {
    const a = adapter();
    vi.mocked(a.update).mockRejectedValueOnce(
      new AgentMemoryConflictError("conflict"),
    );
    mount(a);
    fireEvent.click(await screen.findByRole("treeitem", { name: first.path }));
    const title = await screen.findByRole("textbox", {
      name: "Markdown document",
    });
    fireEvent.change(title, {
      target: {
        value: formatMemoryDocument({ ...first, title: "Local draft" }),
      },
    });
    vi.mocked(a.read).mockResolvedValueOnce({
      ...first,
      title: "Changed by agent",
      updatedAt: "2026-11-14T00:00:02Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(title).toHaveValue(
        formatMemoryDocument({
          ...first,
          title: "Changed by agent",
          updatedAt: "2026-11-14T00:00:02Z",
        }),
      ),
    );
  });
  it("asks before discarding edits when switching files", async () => {
    const a = adapter();
    mount(a);
    fireEvent.click(await screen.findByRole("treeitem", { name: first.path }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Markdown document" }),
      {
        target: { value: formatMemoryDocument({ ...first, title: "Draft" }) },
      },
    );
    fireEvent.click(screen.getByRole("treeitem", { name: second.path }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Your unsaved changes will be lost."),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("textbox", { name: "Markdown document" }),
    ).toHaveValue(formatMemoryDocument({ ...first, title: "Draft" }));
  });
  it("deletes only after confirmation and restores from trash", async () => {
    const a = adapter();
    mount(a);
    fireEvent.click(await screen.findByRole("treeitem", { name: first.path }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(a.remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(a.remove).toHaveBeenCalledWith("agent", first.path),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: "20261114T000000Z/" + first.path,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(a.restore).toHaveBeenCalled());
    expect(
      await screen.findByRole("textbox", { name: "Markdown document" }),
    ).toHaveValue(formatMemoryDocument(first));
  });
  it("keeps members without edit access read-only", async () => {
    const a = adapter();
    mount(a, false);
    fireEvent.click(await screen.findByRole("treeitem", { name: first.path }));
    expect(
      await screen.findByRole("textbox", { name: "Markdown document" }),
    ).toHaveAttribute("readonly");
    for (const name of ["Save", "Delete", "Clear memory"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });
  it("explains invalid fields and prevents an invalid save", async () => {
    const a = adapter();
    mount(a);
    fireEvent.click(await screen.findByRole("treeitem", { name: first.path }));
    const title = await screen.findByRole("textbox", {
      name: "Markdown document",
    });
    fireEvent.change(title, {
      target: { value: formatMemoryDocument({ ...first, title: "" }) },
    });
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("title must be a non-empty string.")).toBeVisible();
    fireEvent.change(title, {
      target: {
        value: formatMemoryDocument({ ...first, body: "界".repeat(2800) }),
      },
    });
    expect(screen.getByText(/8KB or smaller/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(a.update).not.toHaveBeenCalled();
  });
  it("preserves a failed draft and allows retry without duplicate saves", async () => {
    const a = adapter();
    let fail!: (error: Error) => void;
    vi.mocked(a.update).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    mount(a);
    fireEvent.click(await screen.findByRole("treeitem", { name: first.path }));
    const title = await screen.findByRole("textbox", {
      name: "Markdown document",
    });
    fireEvent.change(title, {
      target: {
        value: formatMemoryDocument({ ...first, title: "Retry this draft" }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("button", { name: "Saving..." }),
    ).toBeDisabled();
    fail(new Error("unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not access memory",
    );
    expect(title).toHaveValue(
      formatMemoryDocument({ ...first, title: "Retry this draft" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(a.update).toHaveBeenCalledTimes(2);
  });
  it("requires an explicit confirmation to clear all memory", async () => {
    const a = adapter();
    mount(a);
    fireEvent.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Clear memory" }),
    );
    expect(a.clear).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("30 days");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clear memory" }),
    );
    await waitFor(() => expect(a.clear).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/No memory yet/)).toBeVisible();
  });
  it("debounces searches and hides folders without unmounting the tree", async () => {
    const a = adapter();
    mount(a);
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: "Search memory",
      }),
      { target: { value: "evidence" } },
    );
    expect(
      await screen.findByRole("button", { name: /Search hit/ }),
    ).toBeVisible();
    expect(a.search).toHaveBeenCalledWith("agent", "evidence");
    expect(
      screen.getByRole("treeitem", { name: second.path, hidden: true }),
    ).not.toBeVisible();
  });
});
