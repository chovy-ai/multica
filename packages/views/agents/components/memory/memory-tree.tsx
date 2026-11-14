import { Button } from "@multica/ui/components/ui/button";
import { Search, X } from "lucide-react";
import { IconButton } from "@multica/ui/components/common/icon-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@multica/ui/components/ui/input-group";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import type { AgentMemoryTree } from "./types";
import { MemoryFileTree } from "./memory-file-tree";

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
      className="flex h-56 shrink-0 flex-col gap-3 overflow-hidden border-b p-3 md:h-auto md:w-64 md:border-b-0 md:border-r lg:w-[280px]"
      aria-label={t(($) => $.memory.tree)}
    >
      <InputGroup>
        <InputGroupAddon>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          name="memory-search"
          autoComplete="off"
          aria-label={t(($) => $.memory.search)}
          placeholder={t(($) => $.memory.search)}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {search && (
          <InputGroupAddon align="inline-end">
            <IconButton
              label={t(($) => $.memory.clear_search)}
              size="icon-xs"
              onClick={() => onSearch("")}
            >
              <X />
            </IconButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      {search.trim() ? (
        <div className="min-h-0 overflow-y-auto" aria-live="polite">
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
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden" hidden={!!search.trim()}>
        <MemoryFileTree tree={tree} selection={selection} onSelect={onSelect} />
      </div>
    </aside>
  );
}
