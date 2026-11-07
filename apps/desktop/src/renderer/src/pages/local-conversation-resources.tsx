import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { ChevronRight, File, FileDiff, SlidersHorizontal, X } from "lucide-react";
import type { ConversationResourcesService } from "@multica/conversation-client/services";
import type { ConversationFileResource, ConversationResourceAttachment } from "@multica/core/local-conversation/resources";
import { useT } from "@multica/views/i18n";
import { usePersistCallback } from "@multica/ui/hooks/use-persist-callback";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@multica/ui/components/ui/popover";

export function useResourceLabels() { const { t } = useT("chat"); return {
    title: t($ => $.desktop.resources.title),
    open: t($ => $.desktop.resources.open),
    close: t($ => $.desktop.resources.close),
    changes: t($ => $.desktop.resources.changes),
    outputs: t($ => $.desktop.resources.outputs),
    related: t($ => $.desktop.resources.related),
    cumulative: t($ => $.desktop.resources.cumulative),
    partial: t($ => $.desktop.resources.partial, { time: "{{time}}" }),
    missing: t($ => $.desktop.resources.missing),
    empty: t($ => $.desktop.resources.empty),
    loading: t($ => $.desktop.resources.loading),
    failed: t($ => $.desktop.resources.failed),
    stale: t($ => $.desktop.resources.stale),
    retry: t($ => $.desktop.resources.retry),
    view: t($ => $.desktop.resources.view),
    back: t($ => $.desktop.resources.back),
    choose: t($ => $.desktop.resources.choose),
    unified: t($ => $.desktop.resources.unified),
    split: t($ => $.desktop.resources.split),
    wrap: t($ => $.desktop.resources.wrap),
    expand_for_split: t($ => $.desktop.resources.expand_for_split),
    readonly: t($ => $.desktop.resources.readonly),
    renamed: t($ => $.desktop.resources.renamed),
    no_change: t($ => $.desktop.resources.no_change),
    unsupported: t($ => $.desktop.resources.unsupported),
    text_stats: t($ => $.desktop.resources.text_stats),
    unavailable: t($ => $.desktop.resources.unavailable),
    files: t($ => $.desktop.resources.files),
    preview: t($ => $.desktop.resources.preview),
    file_limit: t($ => $.desktop.resources.file_limit),
    reasons: { uncertain: t($ => $.desktop.resources.reasons.uncertain), missing_baseline: t($ => $.desktop.resources.reasons.missing_baseline), binary: t($ => $.desktop.resources.reasons.binary), large_file: t($ => $.desktop.resources.reasons.large_file), read_failed: t($ => $.desktop.resources.reasons.read_failed), outside_scope: t($ => $.desktop.resources.reasons.outside_scope), excluded: t($ => $.desktop.resources.reasons.excluded), storage_limit: t($ => $.desktop.resources.reasons.storage_limit), scan_limit: t($ => $.desktop.resources.reasons.scan_limit), untracked_tools: t($ => $.desktop.resources.reasons.untracked_tools), other: t($ => $.desktop.resources.reasons.other) },
  };
}
export function resourceReason(labels: ReturnType<typeof useResourceLabels>, reason: string) {
  return labels.reasons[reason as keyof typeof labels.reasons] ?? labels.reasons.other;
}
export const ResourceCounts = ({ file }: { file: ConversationFileResource }) => (
  file.added === null || file.deleted === null ? <span className="text-caption text-muted-foreground">—</span> :
  <span className="flex shrink-0 gap-1 text-caption tabular-nums"><span className="text-success">+{file.added}</span><span className="text-destructive">−{file.deleted}</span></span>
);

export const ConversationResourceStatus = observer(function ConversationResourceStatus({ service }: { service: ConversationResourcesService }) {
  const labels = useResourceLabels(); const model = service.model;
  const retry = usePersistCallback(() => { void service.refresh(); });
  return <>
    {model.supported === false ? <p role="status" className="p-3 text-body text-muted-foreground">{labels.unsupported}</p> : model.error ?
      <div role="alert" className="flex items-center justify-between gap-2 p-3 text-caption text-muted-foreground"><span>{model.data ? labels.stale : labels.failed}</span><Button size="xs" variant="outline" onClick={retry}>{labels.retry}</Button></div> :
      model.loading ? <p role="status" className="p-3 text-caption text-muted-foreground">{labels.loading}</p> : null}
    {model.data?.coverage === "missing_baseline" ? <p className="px-3 py-2 text-caption text-muted-foreground">{labels.missing}</p> : model.data?.coverage === "partial" ?
      <p className="px-3 py-2 text-caption text-muted-foreground">{labels.partial.replace("{{time}}", model.data.recorded_from)} {model.data.reason && resourceReason(labels, model.data.reason)}</p> : null}
  </>;
});

export interface ConversationResourcesButtonProps {
  service: ConversationResourcesService;
  open?: boolean; onOpenChange?(open: boolean): void;
  onChange(fileId: string): void;
  onPreview(file: ConversationFileResource): void;
  onAttachment(attachment: ConversationResourceAttachment): void;
}

export const ConversationResourcesButton = observer(function ConversationResourcesButton(props: ConversationResourcesButtonProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = props.open ?? localOpen;
  const setOpen = usePersistCallback((value: boolean) => { setLocalOpen(value); props.onOpenChange?.(value); });
  const labels = useResourceLabels();
  useEffect(() => open ? props.service.hold() : undefined, [props.service, open]);
  useEffect(() => setOpen(false), [props.service, setOpen]);
  const close = usePersistCallback(() => setOpen(false));
  const select = usePersistCallback((id: string) => { props.onChange(id); setOpen(false); });
  const preview = usePersistCallback((file: ConversationFileResource) => { props.onPreview(file); setOpen(false); });
  const attachment = usePersistCallback((file: ConversationResourceAttachment) => { props.onAttachment(file); setOpen(false); });
  const data = props.service.model.data;
  const files = data?.files ?? [];
  const outputs = files.filter(file => file.kind === "added" && !file.reason && /\.(?:md|markdown|html?|svg|png|jpe?g|webp)$/i.test(file.path));
  const inputs = data?.attachments.filter(file => file.source === "input") ?? [];
  const outputAttachments = data?.attachments.filter(file => file.source !== "input") ?? [];
  const valid = files.filter(file => file.added !== null && file.deleted !== null);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<IconButton label={open ? labels.close : labels.open} aria-expanded={open} style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} />}><SlidersHorizontal /></PopoverTrigger>
    <PopoverContent role="dialog" aria-label={labels.title} align="end" sideOffset={8} className="max-h-[min(80dvh,44rem)] w-96 max-w-[calc(100vw-1rem)] gap-0 overflow-y-auto rounded-xl p-0 shadow-[var(--floating-shadow)]" data-testid="conversation-resources">
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3"><PopoverTitle>{labels.title}</PopoverTitle><IconButton label={labels.close} onClick={close}><X /></IconButton></div>
      <ConversationResourceStatus service={props.service} />
      {data && <>
        <div className="flex items-center justify-between gap-2 px-4 pt-4 text-label"><span>{labels.changes} · {files.length}</span><span className="flex gap-2 text-caption">{valid.length || (!files.length && data.coverage === "complete") ? <><span className="text-success">+{valid.reduce((n,file)=>n+(file.added??0),0)}</span><span className="text-destructive">−{valid.reduce((n,file)=>n+(file.deleted??0),0)}</span></> : <span className="text-muted-foreground">—</span>}</span></div>
        <p className="px-4 py-2 text-caption text-muted-foreground">{valid.length !== files.length ? labels.text_stats : labels.cumulative}</p>
        {!files.length && data.coverage === "complete" && <p className="px-4 pb-4 text-body text-muted-foreground">{labels.empty}</p>}
        <div className="px-2 pb-3" aria-label={labels.changes}>{files.map(file => <ResourceFileRow key={file.id} file={file} onSelect={select} />)}</div>
        {(outputs.length > 0 || outputAttachments.length > 0) && <div className="border-t px-2 py-3"><h3 className="px-2 pb-2 text-label font-medium">{labels.outputs}</h3>{outputs.map(file => <ResourcePreviewRow key={file.id} file={file} onPreview={preview} />)}{outputAttachments.map(file => <ResourceAttachmentRow key={file.id} file={file} onSelect={attachment} />)}</div>}
        {inputs.length > 0 && <div className="border-t px-2 py-3"><h3 className="px-2 pb-2 text-label font-medium">{labels.related}</h3>{inputs.map(file => <ResourceAttachmentRow key={file.id} file={file} onSelect={attachment} />)}</div>}
      </>}
    </PopoverContent>
  </Popover>;
});

function ResourceFileRow({ file, onSelect }: { file: ConversationFileResource; onSelect(id: string): void }) {
  const click = usePersistCallback(() => onSelect(file.id));
  return <Button variant="ghost" className="h-auto min-h-10 w-full justify-start gap-2 px-2 py-2 text-label" onClick={click} title={`${file.cwd}/${file.path}`}><FileDiff className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-left">{file.path}</span><span className="text-micro">{({added:"A",deleted:"D",renamed:"R",modified:"M"} as Record<string,string>)[file.kind]??"?"}</span><ResourceCounts file={file} /><ChevronRight className="size-3 shrink-0" /></Button>;
}
function ResourcePreviewRow({ file, onPreview }: { file: ConversationFileResource; onPreview(file: ConversationFileResource): void }) {
  const click = usePersistCallback(() => onPreview(file));
  return <Button variant="ghost" className="h-auto min-h-10 w-full justify-start gap-2 px-2 py-2 text-label" onClick={click} title={file.path}><File className="size-4 shrink-0" /><span className="truncate">{file.path}</span><ChevronRight className="ml-auto size-3 shrink-0" /></Button>;
}
function ResourceAttachmentRow({ file, onSelect }: { file: ConversationResourceAttachment; onSelect(file: ConversationResourceAttachment): void }) {
  const click = usePersistCallback(() => onSelect(file));
  return <Button variant="ghost" className="h-auto min-h-10 w-full justify-start gap-2 px-2 py-2 text-label" onClick={click} title={file.name}><File className="size-4 shrink-0" /><span className="truncate">{file.name}</span><ChevronRight className="ml-auto size-3 shrink-0" /></Button>;
}
