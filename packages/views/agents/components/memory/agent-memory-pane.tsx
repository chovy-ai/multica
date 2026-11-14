"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Ellipsis,
  FolderOpen,
  Loader2,
  LockKeyhole,
  Monitor,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentRuntime } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { runtimeDisplayLabel } from "@multica/core/runtimes";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyDescription,
  EmptyContent,
} from "@multica/ui/components/ui/empty";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@multica/ui/components/ui/dropdown-menu";
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
import { MemoryFileHeader, MemoryTimestamp } from "./memory-file-header";

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
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Monitor aria-hidden="true" />
        </EmptyMedia>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
function MemoryLoading() {
  const { t } = useT("agents");
  return (
    <div
      role="status"
      aria-label={t(($) => $.memory.loading)}
      className="space-y-5 p-6"
    >
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
function MemoryError({
  onRetry,
  pending,
}: {
  onRetry: () => void;
  pending: boolean;
}) {
  const { t } = useT("agents");
  return (
    <Empty role="alert" className="h-full">
      <EmptyHeader>
        <EmptyDescription>{t(($) => $.memory.failed)}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={pending}
          aria-busy={pending}
        >
          <RotateCcw aria-hidden="true" />
          {t(($) => $.memory.retry)}
        </Button>
      </EmptyContent>
    </Empty>
  );
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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
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
  if (tree.isPending) return <MemoryLoading />;
  if (tree.isError)
    return (
      <MemoryError
        onRetry={() => void tree.refetch()}
        pending={tree.isFetching}
      />
    );
  const data = tree.data;
  const trash =
    selection.type === "trash"
      ? data.trash.find((e) => e.trashPath === path)
      : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2 md:px-4">
        <FolderOpen
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <code
          className="min-w-0 flex-1 truncate text-caption text-muted-foreground"
          title={data.root}
        >
          {data.root}
        </code>
        <span className="shrink-0 text-caption text-muted-foreground">
          {t(($) => $.memory.entry_count, { count: data.entries.length })}
        </span>
        <IconButton
          label={
            copied ? t(($) => $.memory.copied) : t(($) => $.memory.copy_path)
          }
          onClick={() => {
            void navigator.clipboard
              .writeText(data.root)
              .then(() => setCopied(true))
              .catch(() => toast.error(t(($) => $.memory.failed)));
          }}
        >
          {copied ? <Check /> : <Copy />}
        </IconButton>
        {canEdit && data.entries.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<IconButton label={t(($) => $.memory.more_actions)} />}
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirm("clear")}
              >
                <Trash2 />
                {t(($) => $.memory.clear)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
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
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
          aria-label={t(($) => $.memory.content)}
        >
          {selection.type === "index" ? (
            <div className="flex h-full min-h-0 flex-col">
              <MemoryFileHeader path="MEMORY.md">
                <Badge variant="secondary">
                  <LockKeyhole aria-hidden="true" />
                  {t(($) => $.memory.generated)}
                </Badge>
              </MemoryFileHeader>
              {data.entries.length ? (
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <div className="mx-auto max-w-3xl break-words p-4 md:p-6">
                    <ReadonlyContent content={data.index} />
                  </div>
                </div>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FolderOpen aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyDescription>
                      {t(($) => $.memory.empty)}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
          ) : entry.isPending ? (
            <MemoryLoading />
          ) : entry.isError ? (
            <MemoryError
              onRetry={() => void entry.refetch()}
              pending={entry.isFetching}
            />
          ) : selection.type === "trash" ? (
            <div className="flex h-full min-h-0 flex-col">
              <MemoryFileHeader path={trash?.originalPath ?? path}>
                <Badge variant="secondary">
                  <Trash2 aria-hidden="true" />
                  {t(($) => $.memory.trash)}
                </Badge>
              </MemoryFileHeader>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
                  <p className="text-caption text-muted-foreground">
                    {t(($) => $.memory.deleted)}:{" "}
                    {trash && <MemoryTimestamp value={trash.deletedAt} />}
                  </p>
                  <h3 className="break-words text-title-sm font-medium">
                    {entry.data.title}
                  </h3>
                  <p className="break-words text-body text-muted-foreground">
                    {entry.data.description}
                  </p>
                  <ReadonlyContent content={entry.data.body ?? ""} />
                </div>
              </div>
              {canEdit && (
                <footer className="flex shrink-0 justify-end border-t px-4 py-3 md:px-6">
                  <Button
                    size="sm"
                    disabled={pending}
                    aria-busy={restore.isPending}
                    onClick={() => void restoreEntry()}
                  >
                    {restore.isPending ? (
                      <Loader2
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <RotateCcw aria-hidden="true" />
                    )}
                    {t(($) => $.memory.restore)}
                  </Button>
                </footer>
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
              variant="destructive"
              aria-busy={pending}
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                void commit();
              }}
            >
              {pending && (
                <Loader2
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {confirm === "delete"
                ? t(($) => $.memory.delete)
                : confirm === "clear"
                  ? t(($) => $.memory.clear)
                  : t(($) => $.memory.discard)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
