import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Trash2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Badge } from "@multica/ui/components/ui/badge";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { ReadonlyContent } from "../../../editor/readonly-content";
import { SettingsViewTabs } from "../../../settings/components/settings-layout";
import { useLocale, useT } from "../../../i18n";
import {
  AgentMemoryConflictError,
  type AgentMemoryAdapter,
  type AgentMemoryEntry,
} from "./types";
import { MemoryFileHeader, MemoryTimestamp } from "./memory-file-header";
import { memoryKeys, useMemoryMutation } from "./queries";

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
  const id = useId();
  const qc = useQueryClient();
  const [persisted, setPersisted] = useState(entry);
  const [draft, setDraft] = useState(entry);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty =
    draft.title !== persisted.title ||
    draft.description !== persisted.description ||
    draft.body !== persisted.body;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) {
      setPersisted(entry);
      setDraft(entry);
    }
  }, [entry]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const update = useMemoryMutation<
    void,
    Awaited<ReturnType<AgentMemoryAdapter["update"]>>
  >(wsId, agentId, async () =>
    adapter.update(agentId, {
      path: persisted.path,
      title: draft.title,
      description: draft.description,
      body: draft.body ?? "",
      expectedUpdatedAt: persisted.updatedAt,
    }),
  );
  const size = new TextEncoder().encode(draft.body ?? "").length;
  const titleError =
    !draft.title.trim() ||
    [...draft.title.trim()].length > 100 ||
    /[\r\n]/.test(draft.title);
  const descriptionError =
    !draft.description.trim() ||
    [...draft.description.trim()].length > 200 ||
    /[\r\n]/.test(draft.description);
  const bodyError = !draft.body?.trim() || size > 8192;
  const invalid = titleError || descriptionError || bodyError;
  const change = (next: AgentMemoryEntry) => {
    setDraft(next);
    setSaved(false);
    setFailure(null);
  };
  const save = async () => {
    if (!canEdit || !dirty || invalid || update.isPending) return;
    setFailure(null);
    try {
      const result = await update.mutateAsync();
      setDraft(result.entry);
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
          setDraft(latest);
          setPersisted(latest);
          qc.setQueryData(memoryKeys.entry(wsId, agentId, latest.path), latest);
          setFailure(t(($) => $.memory.conflict));
        } catch {
          setFailure(t(($) => $.memory.failed));
        }
      } else setFailure(t(($) => $.memory.failed));
    }
  };
  const kinds = {
    feedback: t(($) => $.memory.kind_feedback),
    project: t(($) => $.memory.kind_project),
    reference: t(($) => $.memory.kind_reference),
  };
  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <MemoryFileHeader path={entry.path}>
        {!canEdit && (
          <Badge variant="secondary">{t(($) => $.memory.read_only)}</Badge>
        )}
      </MemoryFileHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
          <div className="space-y-2">
            <label htmlFor={`${id}-title`} className="text-label font-medium">
              {t(($) => $.memory.title)}
            </label>
            <Input
              id={`${id}-title`}
              name="title"
              autoComplete="off"
              value={draft.title}
              readOnly={!canEdit}
              disabled={update.isPending}
              aria-invalid={canEdit && titleError}
              aria-describedby={
                canEdit && titleError ? `${id}-title-error` : undefined
              }
              onChange={(event) =>
                change({ ...draft, title: event.target.value })
              }
            />
            {canEdit && titleError && (
              <p
                id={`${id}-title-error`}
                className="text-caption text-destructive"
              >
                {t(($) => $.memory.title_limit)}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label
              htmlFor={`${id}-description`}
              className="text-label font-medium"
            >
              {t(($) => $.memory.description)}
            </label>
            <Input
              id={`${id}-description`}
              name="description"
              autoComplete="off"
              value={draft.description}
              readOnly={!canEdit}
              disabled={update.isPending}
              aria-invalid={canEdit && descriptionError}
              aria-describedby={
                canEdit && descriptionError
                  ? `${id}-description-error`
                  : undefined
              }
              onChange={(event) =>
                change({ ...draft, description: event.target.value })
              }
            />
            {canEdit && descriptionError && (
              <p
                id={`${id}-description-error`}
                className="text-caption text-destructive"
              >
                {t(($) => $.memory.description_limit)}
              </p>
            )}
          </div>
          <dl className="flex flex-wrap gap-x-5 gap-y-2 text-caption text-muted-foreground">
            <div>
              <dt className="inline">{t(($) => $.memory.kind)}: </dt>
              <dd className="inline">{kinds[persisted.kind]}</dd>
            </div>
            <div>
              <dt className="inline">{t(($) => $.memory.updated)}: </dt>
              <dd className="inline">
                <MemoryTimestamp value={persisted.updatedAt} />
              </dd>
            </div>
            {persisted.source && (
              <div className="min-w-0">
                <dt className="inline">{t(($) => $.memory.source)}: </dt>
                <dd className="inline break-all">{persisted.source}</dd>
              </div>
            )}
          </dl>
          <div className="space-y-3">
            {canEdit ? (
              <SettingsViewTabs<"write" | "preview">
                label={t(($) => $.memory.body)}
                items={[
                  { value: "write", label: t(($) => $.memory.edit) },
                  { value: "preview", label: t(($) => $.memory.preview) },
                ]}
                value={mode}
                onChange={setMode}
              />
            ) : (
              <h3 className="text-label font-medium">
                {t(($) => $.memory.body)}
              </h3>
            )}
            {canEdit && mode === "write" ? (
              <Textarea
                name="body"
                aria-label={t(($) => $.memory.body)}
                value={draft.body ?? ""}
                disabled={update.isPending}
                aria-invalid={bodyError}
                aria-describedby={`${id}-body-hint`}
                onChange={(event) =>
                  change({ ...draft, body: event.target.value })
                }
                className="min-h-72 resize-y font-mono text-label leading-relaxed md:text-label"
              />
            ) : (
              <div className="min-h-40 break-words rounded-lg border p-4">
                <ReadonlyContent content={draft.body ?? ""} />
              </div>
            )}
            <div
              id={`${id}-body-hint`}
              className="flex flex-wrap justify-between gap-2 text-caption text-muted-foreground"
            >
              <span
                className={
                  canEdit && bodyError
                    ? "text-destructive"
                    : size > 2048
                      ? "text-warning"
                      : undefined
                }
              >
                {canEdit && bodyError
                  ? t(($) =>
                      size > 8192
                        ? $.memory.hard_limit
                        : $.memory.body_required,
                    )
                  : size > 2048
                    ? t(($) => $.memory.soft_limit)
                    : t(($) => $.memory.markdown_hint)}
              </span>
              <span className="shrink-0 tabular-nums">
                {new Intl.NumberFormat(locale).format(size)} /{" "}
                {new Intl.NumberFormat(locale).format(8192)} B
              </span>
            </div>
          </div>
        </div>
      </div>
      {canEdit && (
        <footer className="shrink-0 border-t bg-background px-4 py-3 md:px-6">
          {failure && (
            <p
              role="alert"
              className="mx-auto mb-3 max-w-3xl text-caption text-destructive"
            >
              {failure}
            </p>
          )}
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={update.isPending}
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" />
              {t(($) => $.memory.delete)}
            </Button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span
                role="status"
                className="flex items-center gap-1 text-caption text-muted-foreground"
              >
                {dirty ? (
                  t(($) => $.memory.unsaved)
                ) : saved ? (
                  <>
                    <Check className="size-3.5" aria-hidden="true" />
                    {t(($) => $.memory.saved)}
                  </>
                ) : null}
              </span>
              <Button
                type="submit"
                size="sm"
                disabled={!dirty || update.isPending || invalid}
                aria-busy={update.isPending}
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
            </div>
          </div>
        </footer>
      )}
    </form>
  );
}
