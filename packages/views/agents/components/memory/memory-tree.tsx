import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import type { AgentMemoryTree } from "./types";

export type MemorySelection =
  | { type: "index" }
  | { type: "entry" | "trash"; path: string };
export function MemoryTree({
  tree,
  selection,
  onSelect,
  search,
  onSearch,
  hits,
  searching,
  searchFailed,
  onRetrySearch,
}: {
  tree: AgentMemoryTree;
  selection: MemorySelection;
  onSelect: (selection: MemorySelection) => void;
  search: string;
  onSearch: (query: string) => void;
  hits: { path: string; title: string; snippet: string }[];
  searching: boolean;
  searchFailed: boolean;
  onRetrySearch: () => void;
}) {
  const { t } = useT("agents");
  const item = (
    path: string,
    title: string,
    type: "entry" | "trash" = "entry",
    snippet?: string,
  ) => {
    const selected = selection.type === type && selection.path === path;
    return (
      <Button
        key={path}
        variant="ghost"
        size="sm"
        className={cn(
          "h-auto w-full justify-start whitespace-normal py-2 text-left",
          selected &&
            "bg-surface-selected text-surface-selected-foreground hover:bg-surface-selected",
        )}
        aria-pressed={selected}
        onClick={() => onSelect({ type, path })}
      >
        <span className="min-w-0">
          <span className="block truncate">{title || path}</span>
          <span className="block truncate font-mono text-caption text-muted-foreground">
            {path}
          </span>
          {snippet && (
            <span className="line-clamp-2 text-caption text-muted-foreground">
              {snippet}
            </span>
          )}
        </span>
      </Button>
    );
  };
  return (
    <aside
      className="max-h-80 shrink-0 space-y-3 overflow-y-auto border-b p-3 md:max-h-none md:w-[280px] md:border-b-0 md:border-r"
      aria-label={t(($) => $.memory.tree)}
    >
      <Input
        aria-label={t(($) => $.memory.search)}
        placeholder={t(($) => $.memory.search)}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          "h-auto w-full justify-start py-2",
          selection.type === "index" &&
            "bg-surface-selected text-surface-selected-foreground hover:bg-surface-selected",
        )}
        aria-pressed={selection.type === "index"}
        onClick={() => onSelect({ type: "index" })}
      >
        <span className="text-left">
          <span className="block font-mono">{"MEMORY.md"}</span>
          <span className="text-caption text-muted-foreground">
            {t(($) => $.memory.generated)}
          </span>
        </span>
      </Button>
      {search.trim() ? (
        <div aria-live="polite">
          {searching ? (
            <p className="p-2 text-caption text-muted-foreground">
              {t(($) => $.memory.loading)}
            </p>
          ) : searchFailed ? (
            <div role="alert">
              <p className="p-2 text-caption text-destructive">
                {t(($) => $.memory.failed)}
              </p>
              <Button variant="outline" size="sm" onClick={onRetrySearch}>
                {t(($) => $.memory.retry)}
              </Button>
            </div>
          ) : hits.length ? (
            hits.map((hit) => item(hit.path, hit.title, "entry", hit.snippet))
          ) : (
            <p className="p-2 text-caption text-muted-foreground">
              {t(($) => $.memory.no_results)}
            </p>
          )}
        </div>
      ) : (
        <>
          {(["feedback", "project", "reference"] as const).map((kind) => {
            const entries = tree.entries.filter((e) => e.kind === kind);
            return (
              <details key={kind} open>
                <summary className="cursor-pointer py-1 text-caption font-medium">
                  {kind}{" "}
                  <span className="text-muted-foreground">
                    {entries.length}
                  </span>
                </summary>
                {kind === "project"
                  ? [...new Set(entries.map((e) => e.projectDir))]
                      .sort((a, b) =>
                        a === "general"
                          ? -1
                          : b === "general"
                            ? 1
                            : a.localeCompare(b),
                      )
                      .map((dir) => (
                        <details key={dir} open className="pl-3">
                          <summary className="cursor-pointer truncate py-1 text-caption">
                            {tree.projects.find((p) => p.dir === dir)?.title ||
                              dir}{" "}
                            <span className="text-muted-foreground">
                              {
                                entries.filter((e) => e.projectDir === dir)
                                  .length
                              }
                            </span>
                          </summary>
                          {entries
                            .filter((e) => e.projectDir === dir)
                            .map((e) => item(e.path, e.title))}
                        </details>
                      ))
                  : entries.map((e) => item(e.path, e.title))}
              </details>
            );
          })}
          <details>
            <summary className="cursor-pointer py-1 text-caption font-medium">
              {t(($) => $.memory.trash)}{" "}
              <span className="text-muted-foreground">{tree.trash.length}</span>
            </summary>
            {tree.trash.map((entry) =>
              item(entry.trashPath, entry.title, "trash"),
            )}
          </details>
        </>
      )}
    </aside>
  );
}
