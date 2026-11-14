import { useLayoutEffect, useMemo, useRef } from "react";
import {
  FileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react";
import type {
  FileTreeRowDecorationContext,
  FileTreeSortEntry,
} from "@pierre/trees";
import { usePersistCallback } from "@multica/ui/hooks/use-persist-callback";
import { useT } from "../../../i18n";
import type { AgentMemoryTree } from "./types";
import type { MemorySelection } from "./memory-tree";

const treeCSS = `:host {
  --trees-accent-override: var(--ring);
  --trees-bg-override: var(--background);
  --trees-fg-override: var(--foreground);
  --trees-fg-muted-override: var(--muted-foreground);
  --trees-selected-bg-override: var(--surface-selected);
  --trees-selected-fg-override: var(--surface-selected-foreground);
  --trees-bg-muted-override: var(--surface-hover);
  --trees-border-color-override: var(--border);
  --trees-border-radius-override: var(--radius-sm);
  --trees-font-size-override: var(--text-label);
  --trees-font-family-override: var(--font-sans);
  --trees-focus-ring-color-override: var(--ring);
}`;
const icons = { set: "minimal" as const, colored: false };

// Pierre sorts flat input paths; parents must precede their descendants.
function comparePaths(left: FileTreeSortEntry, right: FileTreeSortEntry) {
  if (left.path === right.path) return 0;
  if (left.isDirectory && right.path.startsWith(left.path)) return -1;
  if (right.isDirectory && left.path.startsWith(right.path)) return 1;
  const roots = ["MEMORY.md", "feedback", "project", "reference", ".trash"];
  const leftParts = left.path.split("/");
  const rightParts = right.path.split("/");
  const rootOrder =
    roots.indexOf(leftParts[0]!) - roots.indexOf(rightParts[0]!);
  if (rootOrder !== 0) return rootOrder;
  if (leftParts[0] === "project" && leftParts[1] !== rightParts[1]) {
    if (leftParts[1] === "general") return -1;
    if (rightParts[1] === "general") return 1;
  }
  return left.path.localeCompare(right.path);
}

export function MemoryFileTree({
  tree,
  selection,
  onSelect,
}: {
  tree: AgentMemoryTree;
  selection: MemorySelection;
  onSelect: (selection: MemorySelection) => void;
}) {
  const { t } = useT("agents");
  const paths = useMemo(
    () => [
      "MEMORY.md",
      "feedback/",
      "project/",
      "project/general/",
      "reference/",
      ".trash/",
      ...tree.entries.map((entry) => entry.path),
      ...tree.trash.map((entry) => `.trash/${entry.trashPath}`),
    ],
    [tree.entries, tree.trash],
  );
  const selectedPath =
    selection.type === "index"
      ? "MEMORY.md"
      : selection.type === "trash"
        ? `.trash/${selection.path}`
        : selection.path;
  const synchronizing = useRef(false);
  const select = usePersistCallback((selected: readonly string[]) => {
    if (synchronizing.current) return;
    const next = selected.findLast(
      (path) => path !== selectedPath && !path.endsWith("/"),
    );
    if (!next) return;
    if (next === "MEMORY.md") onSelect({ type: "index" });
    else if (next.startsWith(".trash/"))
      onSelect({ type: "trash", path: next.slice(".trash/".length) });
    else onSelect({ type: "entry", path: next });
  });
  const decorate = usePersistCallback(
    ({ item }: FileTreeRowDecorationContext) => {
      if (item.path === "MEMORY.md")
        return {
          icon: "file-tree-icon-lock",
          title: t(($) => $.memory.generated),
        };
      if (item.kind === "directory") {
        const count = item.path.startsWith(".trash/")
          ? tree.trash.filter((entry) =>
              `.trash/${entry.trashPath}`.startsWith(item.path),
            ).length
          : tree.entries.filter((entry) => entry.path.startsWith(item.path))
              .length;
        const project = tree.projects.find(
          (project) => item.path === `project/${project.dir}/`,
        );
        return {
          text: String(count),
          title:
            item.path === ".trash/"
              ? t(($) => $.memory.trash)
              : (project?.title ?? item.path),
        };
      }
      return null;
    },
  );
  const { model } = useFileTree({
    paths,
    sort: comparePaths,
    initialExpansion: "closed",
    initialSelectedPaths: [selectedPath],
    flattenEmptyDirectories: false,
    dragAndDrop: false,
    renaming: false,
    search: false,
    density: "compact",
    icons,
    onSelectionChange: select,
    renderRowDecoration: decorate,
    unsafeCSS: treeCSS,
  });
  const selected = useFileTreeSelection(model);
  const previousPaths = useRef<readonly string[] | null>(null);
  useLayoutEffect(() => {
    synchronizing.current = true;
    try {
      if (previousPaths.current !== paths) {
        const directories = (paths: readonly string[]) => {
          const folders = new Set<string>();
          for (const path of paths) {
            const segments = path.split("/");
            for (let i = 1; i < segments.length; i++)
              folders.add(`${segments.slice(0, i).join("/")}/`);
          }
          return [...folders];
        };
        const expanded = previousPaths.current
          ? directories(previousPaths.current).filter((path) => {
              const item = model.getItem(path);
              return item && "isExpanded" in item && item.isExpanded();
            })
          : directories(paths).filter((path) => !path.startsWith(".trash/"));
        model.resetPaths(paths);
        // Expand through item handles so the pinned index can precede folders.
        for (const path of expanded) {
          const item = model.getItem(path);
          if (item && "expand" in item) item.expand();
        }
        previousPaths.current = paths;
      }
      // Selection belongs to the editor: a dirty-file confirmation may reject
      // a tree click, so restore the approved selection in that case as well.
      for (const previous of model.getSelectedPaths())
        if (previous !== selectedPath) model.getItem(previous)?.deselect();
      const item = model.getItem(selectedPath);
      if (item && !item.isSelected()) item.select();
    } finally {
      synchronizing.current = false;
    }
  }, [model, paths, selectedPath, selected]);

  useLayoutEffect(() => {
    const segments = selectedPath.split("/");
    for (let i = 1; i < segments.length; i++) {
      const folder = model.getItem(`${segments.slice(0, i).join("/")}/`);
      if (folder && "expand" in folder) folder.expand();
    }
    if (model.getItem(selectedPath))
      model.scrollToPath(selectedPath, { focus: false });
  }, [model, selectedPath]);

  return (
    <FileTree
      model={model}
      className="block h-full min-w-0"
      aria-label={t(($) => $.memory.tree)}
    />
  );
}
