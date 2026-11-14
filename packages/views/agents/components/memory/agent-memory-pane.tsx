"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentRuntime } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { runtimeDisplayLabel } from "@multica/core/runtimes";
import { Button } from "@multica/ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { ReadonlyContent } from "../../../editor/readonly-content";
import { useLocalDaemonStatus } from "../../../platform";
import { useT } from "../../../i18n";
import {
  AgentMemoryRestoreTargetError,
  type AgentMemoryAdapter,
} from "./types";
import { memoryKeys, memoryTreeOptions, useMemoryMutation } from "./queries";
import { MemoryTree, type MemorySelection } from "./memory-tree";
import { MemoryEntryEditor } from "./memory-entry-editor";

export function AgentMemoryPane({
  agentId,
  runtime,
  canEdit,
  adapter,
  onDirtyChange,
}: {
  agentId: string;
  runtime: AgentRuntime | null;
  canEdit: boolean;
  adapter?: AgentMemoryAdapter;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useT("agents");
  const status = useLocalDaemonStatus();
  if (!adapter)
    return <MemoryNotice>{t(($) => $.memory.desktop_only)}</MemoryNotice>;
  if (!runtime?.daemon_id || runtime.daemon_id !== status.daemonId)
    return (
      <MemoryNotice>
        {t(($) => $.memory.other_device, {
          device: runtime
            ? runtimeDisplayLabel(runtime)
            : t(($) => $.memory.unknown_device),
        })}
      </MemoryNotice>
    );
  if (!status.running)
    return <MemoryNotice>{t(($) => $.memory.offline)}</MemoryNotice>;
  return (
    <LocalMemoryPane
      agentId={agentId}
      adapter={adapter}
      canEdit={canEdit}
      onDirtyChange={onDirtyChange}
    />
  );
}
function MemoryNotice({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-body text-muted-foreground">{children}</p>;
}
function LocalMemoryPane({
  agentId,
  adapter,
  canEdit,
  onDirtyChange,
}: {
  agentId: string;
  adapter: AgentMemoryAdapter;
  canEdit: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const tree = useQuery(memoryTreeOptions(wsId, agentId, adapter));
  const [selection, setSelection] = useState<MemorySelection>({
    type: "index",
  });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<
    "delete" | "clear" | MemorySelection | null
  >(null);
  const reportDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const hits = useQuery({
    queryKey: memoryKeys.search(wsId, agentId, query),
    queryFn: () => adapter.search(agentId, query),
    enabled: !!query,
  });
  const path = selection.type === "index" ? "" : selection.path;
  const entry = useQuery({
    queryKey: memoryKeys.entry(
      wsId,
      agentId,
      selection.type === "trash" ? `trash:${path}` : path,
    ),
    queryFn: () =>
      selection.type === "trash"
        ? adapter.readTrash(agentId, path)
        : adapter.read(agentId, path),
    enabled: selection.type !== "index",
  });
  const remove = useMemoryMutation(wsId, agentId, (path: string) =>
    adapter.remove(agentId, path),
  );
  const clear = useMemoryMutation<void, void>(wsId, agentId, () =>
    adapter.clear(agentId),
  );
  const restore = useMemoryMutation(wsId, agentId, (path: string) =>
    adapter.restore(agentId, path),
  );
  const select = (next: MemorySelection) => {
    if (JSON.stringify(next) === JSON.stringify(selection)) return;
    if (dirty) setConfirm(next);
    else setSelection(next);
  };
  const pending = remove.isPending || clear.isPending || restore.isPending;
  const commit = async () => {
    try {
      if (confirm === "delete") await remove.mutateAsync(path);
      else if (confirm === "clear") await clear.mutateAsync();
      else if (confirm) {
        reportDirty(false);
        setSelection(confirm);
        setConfirm(null);
        return;
      }
      reportDirty(false);
      setSelection({ type: "index" });
      setConfirm(null);
    } catch {
      toast.error(t(($) => $.memory.failed));
    }
  };
  const restoreEntry = async () => {
    try {
      const restored = await restore.mutateAsync(path);
      setSelection({ type: "entry", path: restored.path });
    } catch (e) {
      toast.error(
        e instanceof AgentMemoryRestoreTargetError
          ? t(($) => $.memory.restore_conflict)
          : t(($) => $.memory.failed),
      );
    }
  };
  if (tree.isPending)
    return <MemoryNotice>{t(($) => $.memory.loading)}</MemoryNotice>;
  if (tree.isError)
    return (
      <div role="alert" className="space-y-3 p-6">
        <p>{t(($) => $.memory.failed)}</p>
        <Button variant="outline" size="sm" onClick={() => void tree.refetch()}>
          {t(($) => $.memory.retry)}
        </Button>
      </div>
    );
  const data = tree.data;
  const trash =
    selection.type === "trash"
      ? data.trash.find((e) => e.trashPath === path)
      : undefined;
  return (
    <div className="flex min-h-full flex-col md:h-full">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <code className="min-w-0 basis-full break-all text-caption md:basis-auto md:flex-1">
          {data.root}
        </code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard
              .writeText(data.root)
              .catch(() => toast.error(t(($) => $.memory.failed)));
          }}
        >
          {t(($) => $.memory.copy_path)}
        </Button>
        <span className="text-caption text-muted-foreground">
          {t(($) => $.memory.entry_count, { count: data.entries.length })}
        </span>
        {canEdit && data.entries.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirm("clear")}
          >
            {t(($) => $.memory.clear)}
          </Button>
        )}
      </header>
      {!data.entries.length && (
        <MemoryNotice>{t(($) => $.memory.empty)}</MemoryNotice>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <MemoryTree
          tree={data}
          selection={selection}
          onSelect={select}
          search={search}
          onSearch={setSearch}
          hits={query === search.trim() ? (hits.data ?? []) : []}
          searchFailed={hits.isError}
          onRetrySearch={() => void hits.refetch()}
          searching={
            !!search.trim() && (query !== search.trim() || hits.isFetching)
          }
        />
        <section
          className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6"
          aria-label={t(($) => $.memory.content)}
        >
          {selection.type === "index" ? (
            <ReadonlyContent content={data.index} />
          ) : entry.isPending ? (
            <MemoryNotice>{t(($) => $.memory.loading)}</MemoryNotice>
          ) : entry.isError ? (
            <div role="alert">
              <p>{t(($) => $.memory.failed)}</p>
              <Button variant="outline" onClick={() => void entry.refetch()}>
                {t(($) => $.memory.retry)}
              </Button>
            </div>
          ) : selection.type === "trash" ? (
            <div className="space-y-4">
              <p className="break-all font-mono text-caption">
                {trash?.originalPath}
              </p>
              <p className="text-caption text-muted-foreground">
                {t(($) => $.memory.deleted)}: {trash?.deletedAt}
              </p>
              <h2 className="text-title-sm">{entry.data.title}</h2>
              <ReadonlyContent content={entry.data.body ?? ""} />
              {canEdit && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => void restoreEntry()}
                >
                  {t(($) => $.memory.restore)}
                </Button>
              )}
            </div>
          ) : (
            <MemoryEntryEditor
              key={path}
              entry={entry.data}
              adapter={adapter}
              wsId={wsId}
              agentId={agentId}
              canEdit={canEdit}
              onDirtyChange={reportDirty}
              onDelete={() => setConfirm("delete")}
            />
          )}
        </section>
      </div>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "delete"
                ? t(($) => $.memory.delete)
                : confirm === "clear"
                  ? t(($) => $.memory.clear)
                  : t(($) => $.memory.discard)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? t(($) => $.memory.delete_hint)
                : confirm === "clear"
                  ? t(($) => $.memory.clear_hint)
                  : t(($) => $.memory.discard_hint)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              {t(($) => $.memory.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                void commit();
              }}
            >
              {t(($) => $.memory.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
