import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { ReadonlyContent } from "../../../editor/readonly-content";
import { SettingsViewTabs } from "../../../settings/components/settings-layout";
import { useT } from "../../../i18n";
import {
  AgentMemoryConflictError,
  type AgentMemoryAdapter,
  type AgentMemoryEntry,
} from "./types";
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
  const qc = useQueryClient();
  const [persisted, setPersisted] = useState(entry);
  const [draft, setDraft] = useState(entry);
  const [mode, setMode] = useState<"write" | "preview">("write");
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
  const save = async () => {
    try {
      const result = await update.mutateAsync();
      setDraft(result.entry);
      setPersisted(result.entry);
      qc.setQueryData(
        memoryKeys.entry(wsId, agentId, result.entry.path),
        result.entry,
      );
      if (result.warnings.includes("body_over_soft_limit"))
        toast.warning(t(($) => $.memory.soft_limit));
    } catch (error) {
      if (error instanceof AgentMemoryConflictError) {
        try {
          const latest = await adapter.read(agentId, persisted.path);
          setDraft(latest);
          setPersisted(latest);
          qc.setQueryData(memoryKeys.entry(wsId, agentId, latest.path), latest);
          toast.error(t(($) => $.memory.conflict));
        } catch {
          toast.error(t(($) => $.memory.failed));
        }
      } else toast.error(t(($) => $.memory.failed));
    }
  };
  return (
    <div className="space-y-4">
      <p className="break-all font-mono text-caption text-muted-foreground">
        {entry.path}
      </p>
      <label className="block space-y-1 text-label">
        {t(($) => $.memory.title)}
        <Input
          value={draft.title}
          readOnly={!canEdit}
          disabled={update.isPending}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <label className="block space-y-1 text-label">
        {t(($) => $.memory.description)}
        <Input
          value={draft.description}
          readOnly={!canEdit}
          disabled={update.isPending}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-caption text-muted-foreground">
        <div>
          <dt className="inline">{t(($) => $.memory.kind)}: </dt>
          <dd className="inline">{entry.kind}</dd>
        </div>
        <div>
          <dt className="inline">{t(($) => $.memory.updated)}: </dt>
          <dd className="inline">{persisted.updatedAt}</dd>
        </div>
        <div>
          <dt className="inline">{t(($) => $.memory.source)}: </dt>
          <dd className="inline">{persisted.source}</dd>
        </div>
        <div>
          <dt className="inline">{t(($) => $.memory.size)}: </dt>
          <dd className="inline">{size} B</dd>
        </div>
      </dl>
      {canEdit && (
        <SettingsViewTabs<"write" | "preview">
          label={t(($) => $.memory.body)}
          items={[
            { value: "write", label: t(($) => $.memory.edit) },
            { value: "preview", label: t(($) => $.memory.preview) },
          ]}
          value={mode}
          onChange={setMode}
        />
      )}
      {canEdit && mode === "write" ? (
        <Textarea
          aria-label={t(($) => $.memory.body)}
          value={draft.body ?? ""}
          disabled={update.isPending}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          className="min-h-80 font-mono text-label"
        />
      ) : (
        <ReadonlyContent content={draft.body ?? ""} />
      )}
      {size > 8192 && (
        <p role="alert" className="text-caption text-destructive">
          {t(($) => $.memory.hard_limit)}
        </p>
      )}
      {canEdit && (
        <div className="flex justify-between gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={update.isPending}
            onClick={onDelete}
          >
            {t(($) => $.memory.delete)}
          </Button>
          <Button
            size="sm"
            disabled={
              !dirty ||
              update.isPending ||
              size > 8192 ||
              !draft.title.trim() ||
              [...draft.title.trim()].length > 100 ||
              !draft.description.trim() ||
              [...draft.description.trim()].length > 200 ||
              !draft.body?.trim()
            }
            aria-busy={update.isPending}
            onClick={() => void save()}
          >
            {t(($) => $.memory.save)}
          </Button>
        </div>
      )}
    </div>
  );
}
