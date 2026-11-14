import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { ArrowLeft, FileDiff, Loader2, PanelLeft, WrapText, X } from "lucide-react";
import type { ConversationResourcesService } from "@multica/conversation-client/services";
import { usePersistCallback } from "@multica/ui/hooks/use-persist-callback";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { ConversationResourceStatus, ResourceCounts, resourceReason, useResourceLabels } from "./local-conversation-resources";

const ChangeTree = lazy(() => import("./local-change-renderer").then(module => ({ default: module.ChangeTree })));
const ChangeDiff = lazy(() => import("./local-change-renderer").then(module => ({ default: module.ChangeDiff })));
const Loading = () => <div role="status" className="flex flex-1 items-center justify-center p-4"><Loader2 className="size-4 animate-spin" /></div>;

export const LocalChangePreview = observer(function LocalChangePreview({ service, fileId, active, expanded, onSelect, onBack }: {
  service: ConversationResourcesService; fileId?: string; active: boolean; expanded: boolean; onSelect(id: string): void; onBack(): void;
}) {
  const labels = useResourceLabels();
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(true);
  const [split, setSplit] = useState(false); const [wrap, setWrap] = useState(false); const [treeOpen, setTreeOpen] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry!.contentRect.width < 640));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => active ? service.hold() : undefined, [service, active]);
  useEffect(() => active && fileId ? service.follow(fileId) : undefined, [service, active, fileId]);
  useEffect(() => { if (!narrow || !active) setTreeOpen(false); }, [narrow, active]);
  const select = usePersistCallback((id: string) => { onSelect(id); setTreeOpen(false); });
  const closeTree = usePersistCallback(() => setTreeOpen(false));
  const toggleWrap = usePersistCallback(() => setWrap(!wrap));
  const unified = usePersistCallback(() => setSplit(false));
  const parallel = usePersistCallback(() => setSplit(true));
  const file = service.model.data?.files.find(file => file.id === fileId);
  const path = file ? `${file.old_path ? `${file.old_path} → ` : ""}${file.path}` : labels.choose;
  const fullPath = file ? `${file.cwd}/${path}` : labels.choose;
  const detail = fileId ? service.model.details.get(fileId) : undefined;
  const model = service.model;
  const files = model.data?.files ?? [];
  const tree = files.length ? <Suspense fallback={<Loading />}><ChangeTree files={files} selected={fileId} onSelect={select} label={labels.choose} /></Suspense> :
    model.data && !model.loading && !model.error && model.supported !== false ? <p role="status" className="p-3 text-body text-muted-foreground">{labels.empty}</p> : null;
  return <div ref={root} className="flex h-full min-h-0 min-w-0 flex-col bg-surface" data-testid="conversation-change-preview">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2"><Button variant="ghost" size="xs" onClick={onBack}><ArrowLeft />{labels.back}</Button><span className="ml-auto text-caption text-muted-foreground">{labels.cumulative}</span></div>
    {(!narrow || !treeOpen) && <ConversationResourceStatus service={service} />}
    <div className="flex min-h-0 min-w-0 flex-1">
      {!narrow && <div className="w-44 shrink-0 overflow-auto border-r">{tree}</div>}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 shrink-0 flex-col gap-2 border-b px-3 py-2">
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} className="block min-w-0 truncate text-caption" title={fullPath} />}>{path}</TooltipTrigger>
            <TooltipContent className="break-all">{fullPath}</TooltipContent>
          </Tooltip>
          <div className="flex flex-wrap items-center gap-2">
          {narrow && <Popover open={treeOpen} onOpenChange={setTreeOpen}>
            <PopoverTrigger render={<IconButton label={labels.choose} aria-expanded={treeOpen} />}><PanelLeft /></PopoverTrigger>
            <PopoverContent align="start" sideOffset={8} className="w-80 max-w-(--available-width) max-h-(--available-height) gap-0 overflow-hidden p-0" data-testid="conversation-change-picker">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2"><PopoverTitle>{labels.choose}</PopoverTitle><IconButton label={labels.close} onClick={closeTree}><X /></IconButton></div>
              <div className="flex min-h-0 flex-col overflow-auto">
                <ConversationResourceStatus service={service} />
                {files.length ? <div className="h-72 min-h-0 shrink-0 overflow-auto p-2">{tree}</div> : tree}
              </div>
            </PopoverContent>
          </Popover>}
          {file && <ResourceCounts file={file} />}
          <Button size="xs" variant={!split ? "secondary" : "ghost"} aria-pressed={!split} onClick={unified}>{labels.unified}</Button>
          <Button size="xs" variant={split ? "secondary" : "ghost"} disabled={!expanded || narrow} title={!expanded ? labels.expand_for_split : undefined} aria-pressed={split && expanded && !narrow} onClick={parallel}>{labels.split}</Button>
          <IconButton label={labels.wrap} aria-pressed={wrap} onClick={toggleWrap}><WrapText /></IconButton>
          </div>
        </div>
        <div className={`min-h-0 min-w-0 flex-1 pb-chat-launcher ${file && !file.reason ? "overflow-hidden" : "overflow-auto"}`} role="region" aria-label={labels.view} tabIndex={file && !file.reason ? -1 : 0}>
          {file?.reason ? <p className="p-4 text-body text-muted-foreground">{resourceReason(labels, file.reason)}</p> : file ? detail && !detail.patch ?
            <p className="p-4 text-body text-muted-foreground">{file.kind === "renamed" ? labels.renamed : labels.no_change}</p> :
            <Suspense fallback={<Loading />}><ChangeDiff file={file} detail={detail} split={split && expanded && !narrow} wrap={wrap} /></Suspense> :
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-body text-muted-foreground"><FileDiff className="size-6" /><p>{fileId ? labels.no_change : labels.choose}</p></div>}
        </div>
        <p className="shrink-0 border-t px-3 py-2 text-caption text-muted-foreground">{labels.readonly}</p>
      </div>
    </div>
  </div>;
});
