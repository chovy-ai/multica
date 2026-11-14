import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Loader2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { Badge } from "@multica/ui/components/ui/badge";
import { ReadonlyContent } from "../../../editor/readonly-content";
import { SettingsViewTabs } from "../../../settings/components/settings-layout";
import { useLocale, useT } from "../../../i18n";
import {
  AgentMemoryConflictError,
  type AgentMemoryAdapter,
  type AgentMemoryEntry,
} from "./types";
import { MemoryFileHeader } from "./memory-file-header";
import { memoryKeys, useMemoryMutation } from "./queries";
import {
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryDiagnostic,
} from "./memory-document";
import {
  MemoryCodeEditor,
  type MemoryEditorHandle,
} from "./memory-code-editor";

export function MemoryEntryEditor({
  entry,
  adapter,
  wsId,
  agentId,
  canEdit,
  onDirtyChange,
  onDelete,
}: {
  entry: AgentMemoryEntry;
  adapter: AgentMemoryAdapter;
  wsId: string;
  agentId: string;
  canEdit: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useT("agents");
  const locale = useLocale();
  const qc = useQueryClient();
  const editor = useRef<MemoryEditorHandle>(null);
  const [persisted, setPersisted] = useState(entry);
  const [draft, setDraft] = useState(() => formatMemoryDocument(entry));
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const dirty = draft !== formatMemoryDocument(persisted);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) {
      setPersisted(entry);
      setDraft(formatMemoryDocument(entry));
    }
  }, [entry]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const parsed = useMemo(
    () => parseMemoryDocument(draft, persisted),
    [draft, persisted],
  );
  const message = (d: MemoryDiagnostic) => {
    switch (d.code) {
      case "title":
        return t(($) => $.memory.title_limit);
      case "description":
        return t(($) => $.memory.description_limit);
      case "body":
        return t(($) => $.memory.body_required);
      case "hard_limit":
        return t(($) => $.memory.hard_limit);
      case "soft_limit":
        return t(($) => $.memory.soft_limit);
      case "opening":
        return t(($) => $.memory.diagnostics.opening);
      case "closing":
        return t(($) => $.memory.diagnostics.closing);
      case "mapping":
        return t(($) => $.memory.diagnostics.mapping);
      case "duplicate":
        return t(($) => $.memory.diagnostics.duplicate);
      case "required":
        return t(($) => $.memory.diagnostics.required, { field: d.field });
      case "missing_colon":
        return t(($) => $.memory.diagnostics.missing_colon, { field: d.field });
      case "system":
        return t(($) => $.memory.diagnostics.system, { field: d.field });
      case "yaml":
        return t(($) => $.memory.diagnostics.yaml, { detail: d.detail });
    }
  };
  const markers = parsed.diagnostics.map((d) => ({
    ...d,
    message: message(d),
  }));
  const errors = markers.filter((m) => m.severity === "error").length;
  const warnings = markers.length - errors;
  const update = useMemoryMutation<
    void,
    Awaited<ReturnType<AgentMemoryAdapter["update"]>>
  >(wsId, agentId, () =>
    adapter.update(agentId, {
      path: persisted.path,
      document: draft,
      expectedUpdatedAt: persisted.updatedAt,
    }),
  );
  const save = async () => {
    if (!canEdit || !dirty || errors || update.isPending) return;
    setFailure(null);
    try {
      const result = await update.mutateAsync();
      setDraft(formatMemoryDocument(result.entry));
      setPersisted(result.entry);
      setSaved(true);
      qc.setQueryData(
        memoryKeys.entry(wsId, agentId, result.entry.path),
        result.entry,
      );
    } catch (error) {
      if (error instanceof AgentMemoryConflictError) {
        try {
          const latest = await adapter.read(agentId, persisted.path);
          setDraft(formatMemoryDocument(latest));
          setPersisted(latest);
          qc.setQueryData(memoryKeys.entry(wsId, agentId, latest.path), latest);
          setFailure(t(($) => $.memory.conflict));
        } catch {
          setFailure(t(($) => $.memory.failed));
        }
      } else setFailure(t(($) => $.memory.failed));
    }
  };
  const location = (offset: number) => {
    const lines = draft.slice(0, offset).split("\n");
    return t(($) => $.memory.cursor_position, {
      line: lines.length,
      column: lines.at(-1)!.length + 1,
    });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <MemoryFileHeader path={entry.path}>
        {!canEdit && (
          <Badge variant="secondary">{t(($) => $.memory.read_only)}</Badge>
        )}
        <SettingsViewTabs<"write" | "preview">
          label={t(($) => $.memory.document)}
          items={[
            { value: "write", label: t(($) => $.memory.edit) },
            { value: "preview", label: t(($) => $.memory.preview) },
          ]}
          value={mode}
          onChange={setMode}
        />
        {canEdit && (
          <>
            <IconButton
              label={t(($) => $.memory.delete)}
              disabled={update.isPending}
              onClick={onDelete}
            >
              <Trash2 />
            </IconButton>
            <Button
              size="sm"
              disabled={!dirty || update.isPending || errors > 0}
              aria-busy={update.isPending}
              onClick={() => void save()}
            >
              {update.isPending && (
                <Loader2
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {update.isPending
                ? t(($) => $.memory.saving)
                : t(($) => $.memory.save)}
            </Button>
          </>
        )}
      </MemoryFileHeader>
      {failure && (
        <p
          role="alert"
          className="shrink-0 border-b px-4 py-2 text-caption text-destructive"
        >
          {failure}
        </p>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="h-full" hidden={mode !== "write"}>
          <MemoryCodeEditor
            ref={editor}
            value={draft}
            readOnly={!canEdit || update.isPending}
            label={t(($) => $.memory.document)}
            markers={markers}
            onSave={() => void save()}
            onCursor={(line, column) => setCursor({ line, column })}
            onChange={(value) => {
              setDraft(value);
              setSaved(false);
              setFailure(null);
            }}
          />
        </div>
        {mode === "preview" && (
          <div className="h-full overflow-y-auto overscroll-contain p-4 md:p-6">
            <article className="mx-auto max-w-3xl break-words">
              <h3 className="mb-2 text-title font-semibold">
                {parsed.title || persisted.title}
              </h3>
              <p className="mb-6 text-body text-muted-foreground">
                {parsed.description}
              </p>
              <ReadonlyContent content={parsed.body} />
            </article>
          </div>
        )}
      </div>
      {!!markers.length && problemsOpen && (
        <section
          aria-label={t(($) => $.memory.problems)}
          aria-live="polite"
          className="flex max-h-44 shrink-0 flex-col border-t bg-muted/30"
        >
          <div className="flex shrink-0 items-center justify-between px-4 py-1">
            <h3 className="text-caption font-medium">
              {t(($) => $.memory.problems)}{" "}
              <span className="ml-1 text-muted-foreground">
                {markers.length}
              </span>
            </h3>
            <IconButton
              size="icon-xs"
              label={t(($) => $.memory.hide_problems)}
              onClick={() => setProblemsOpen(false)}
            >
              <X />
            </IconButton>
          </div>
          <div className="min-h-0 overflow-y-auto pb-2">
            {markers.map((m, i) => (
              <Button
                key={`${m.start}-${i}`}
                size="sm"
                variant="ghost"
                className="h-auto w-full justify-start gap-2 rounded-none px-4 py-2 text-left"
                onClick={() => {
                  setMode("write");
                  requestAnimationFrame(() => editor.current?.reveal(m));
                }}
              >
                {m.severity === "error" ? (
                  <CircleAlert
                    className="text-destructive"
                    aria-hidden="true"
                  />
                ) : (
                  <TriangleAlert className="text-warning" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 whitespace-normal break-words text-caption">
                  {m.message}
                </span>
                <span className="shrink-0 text-micro text-muted-foreground">
                  {location(m.start)}
                </span>
              </Button>
            ))}
          </div>
        </section>
      )}
      <footer className="flex min-h-8 shrink-0 items-center gap-3 border-t px-3 text-micro text-muted-foreground">
        <span className="hidden sm:inline">{"Markdown"}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-label={t(($) => $.memory.problems)}
          aria-expanded={!!markers.length && problemsOpen}
          className="gap-2 px-0 text-micro"
          onClick={() => setProblemsOpen((v) => !v)}
          disabled={!markers.length}
        >
          <span
            className={
              errors
                ? "flex items-center gap-1 text-destructive"
                : "flex items-center gap-1"
            }
          >
            <CircleAlert className="size-3" aria-hidden="true" />
            {errors}
          </span>
          <span
            className={
              warnings
                ? "flex items-center gap-1 text-warning"
                : "flex items-center gap-1"
            }
          >
            <TriangleAlert className="size-3" aria-hidden="true" />
            {warnings}
          </span>
        </Button>
        <span
          role="status"
          className="flex min-w-0 items-center gap-1 truncate"
        >
          {dirty ? (
            t(($) => $.memory.unsaved)
          ) : saved ? (
            <>
              <Check className="size-3 shrink-0" aria-hidden="true" />
              {t(($) => $.memory.saved)}
            </>
          ) : null}
        </span>
        <span className="flex-1" />
        <span className="hidden tabular-nums sm:inline">
          {t(($) => $.memory.cursor_position, cursor)}
        </span>
        <span className="shrink-0 tabular-nums">
          {t(($) => $.memory.body_size, {
            bytes: new Intl.NumberFormat(locale).format(parsed.bytes),
          })}
        </span>
      </footer>
    </div>
  );
}
