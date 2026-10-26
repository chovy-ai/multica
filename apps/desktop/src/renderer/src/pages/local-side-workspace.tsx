import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { getCurrentWsId } from "@multica/core/platform";
import { ArrowLeft, File, FolderOpen, Globe, Maximize2, MessagesSquare, Minimize2, PanelRightOpen, Plus, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@multica/ui/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle, useDefaultLayout } from "@multica/ui/components/ui/resizable";
import { TuttiAgentGuiPanel } from "@multica/views/conversation-flow/panel";
import type { ParentServiceOptions } from "@multica/views/conversation-flow/service";
import type { LocalConversation, LocalConversationScope, LocalPreviewLocation, LocalProviderId } from "@multica/tutti-agent-gui-host/local-protocol";
import { localResourceTarget } from "@multica/tutti-agent-gui-host/message-resource-links";
import { createLocalConversationParentService, localTargetId } from "../platform/local-conversation-service";
import { LocalFilePreview, PreviewFolder, WebResourcePreview } from "./local-resource-preview";

type Tab = { id: string; kind: "side"; sessionId: string } | { id: string; kind: "file"; location: LocalPreviewLocation; selected?: LocalPreviewLocation; sourceId?: string; line?: number } | { id: string; kind: "web"; url: string; title?: string };
export interface SideWorkspaceHandle { openSide(id: string): void; openResource(sessionId: string, url: string): Promise<void>; toggle(): void }
interface Props {
  scope: LocalConversationScope; slug: string; source?: LocalConversation; provider: LocalProviderId; sessions: LocalConversation[];
  chinese: boolean; active: boolean; onSelectSource(id: string, turnId?: string, quote?: string): void;
  onShowMessage(message: string, tone?: "info" | "warning" | "error"): void;
  onOpenTask(id: string): void; onReference(content: string): void;
  children: (visible: boolean) => ReactNode;
  onOpenChange?: (open: boolean) => void;
}
function readLayout(key: string): { tabs: Tab[]; selected: string | null; open: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    if (!value || !Array.isArray(value.tabs)) throw new Error();
    const tabs = value.tabs.filter((tab: Tab) => tab && typeof tab.id === "string" && (tab.kind === "side" ? typeof tab.sessionId === "string" : tab.kind === "web" ? typeof tab.url === "string" && /^https?:\/\//i.test(tab.url) : tab.kind === "file" && typeof tab.location?.root === "string" && typeof tab.location?.path === "string")).slice(0, 20);
    return { tabs, selected: tabs.some((tab: Tab) => tab.id === value.selected) ? value.selected : tabs[0]?.id ?? null, open: value.open === true };
  } catch { return { tabs: [], selected: null, open: false }; }
}

export const LocalSideWorkspace = forwardRef<SideWorkspaceHandle, Props>(function LocalSideWorkspace(props, ref) {
  const key = `multica-side-workspace:${props.scope.userId}:${props.scope.workspaceId}`;
  const [layout, setLayout] = useState(() => readLayout(key));
  const [maximized, setMaximized] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false), [address, setAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "multica-side-workspace-width" });
  useEffect(() => { setLayout(readLayout(key)); }, [key]);
  const onOpenChange = props.onOpenChange;
  useEffect(() => { onOpenChange?.(layout.open); }, [layout.open, onOpenChange]);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* Keep this open workspace usable when preference storage is full. */ } }, [layout, key]);
  useEffect(() => {
    if (layout.open) root.current?.querySelector('[role="tab"][aria-selected="true"]')?.parentElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [layout.selected, layout.open]);
  useEffect(() => { const element = root.current; if (!element) return; const observer = new ResizeObserver(([entry]) => setNarrow(entry!.contentRect.width < 760)); observer.observe(element); return () => observer.disconnect(); }, []);
  const add = useCallback((tab: Tab) => { setLayout((current) => {
    const existing = current.tabs.find((item) => item.id === tab.id || (item.kind === "web" && tab.kind === "web" && item.url === tab.url) || (item.kind === "file" && tab.kind === "file" && (item.selected ?? item.location).path === (tab.selected ?? tab.location).path));
    return { tabs: existing ? current.tabs.map((item) => item.id === existing.id && item.kind === "file" && tab.kind === "file" ? { ...item, line: tab.line } : item) : [...current.tabs, tab], selected: existing?.id ?? tab.id, open: true };
  }); setError(""); }, []);
  const openSide = useCallback((id: string) => add({ id: `side:${id}`, kind: "side", sessionId: id }), [add]);
  const openResource = useCallback(async (sessionId: string, value: string) => {
    if (/^https?:\/\//i.test(value)) { const url = new URL(value); if (url.username || url.password) throw new Error("Use a webpage address without credentials"); add({ id: `web:${crypto.randomUUID()}`, kind: "web", url: url.href }); return; }
    const source = await window.desktopAPI.localConversations.request(latest.current.scope, "read", { id: sessionId });
    const target = localResourceTarget(value);
    if (!target) throw new Error("Use a local file path or webpage address");
    const path = /^(?:\/|[a-z]:[\\/])/i.test(target.path) ? target.path : `${source.cwd}/${target.path}`;
    const file = await window.desktopAPI.localConversations.request(latest.current.scope, "previewRead", { root: source.cwd, path, id: source.id });
    add({ id: `file:${crypto.randomUUID()}`, kind: "file", sourceId: source.id, line: target.line, location: { root: source.cwd, path: file.path, name: file.name, kind: "file" } });
  }, [add]);
  useImperativeHandle(ref, () => ({ openSide, openResource, toggle: () => setLayout((current) => ({ ...current, open: !current.open })) }), [openSide, openResource]);
  const showError = (error: unknown) => { const message = error instanceof Error ? error.message : String(error); setError(message); props.onShowMessage(message, "error"); };
  const createSide = async () => {
    if (creating) return; setCreating(true);
    try {
      let source = props.source;
      if (!source) { source = await window.desktopAPI.localConversations.request(props.scope, "create", { provider: props.provider }); props.onSelectSource(source.id); }
      const side = await window.desktopAPI.localConversations.request(props.scope, "sideCreate", { id: source.id, requestId: crypto.randomUUID() }); openSide(side.id);
    } catch (error) { showError(error); } finally { setCreating(false); }
  };
  const chooseFile = async (kind: "file" | "directory") => {
    try { const location = await window.desktopAPI.localConversations.request(props.scope, "previewChoose", { kind }); if (location) add({ id: `file:${crypto.randomUUID()}`, kind: "file", location }); }
    catch (error) { showError(error); }
  };
  const close = (id: string) => setLayout((current) => { const tabs = current.tabs.filter((tab) => tab.id !== id); return { tabs, selected: current.selected === id ? tabs.at(-1)?.id ?? null : current.selected, open: tabs.length > 0 && current.open }; });
  const sideVisible = layout.open, mainVisible = !(sideVisible && (maximized || narrow));
  const title = (tab: Tab) => tab.kind === "side" ? `${props.chinese ? "旁支" : "Side"} · ${props.sessions.find((entry) => entry.id === tab.sessionId)?.title.replace(/ · Side$/, "") ?? (props.chinese ? "新对话" : "New chat")}` : tab.kind === "web" ? tab.title || new URL(tab.url).hostname : (tab.selected ?? tab.location).name;
  const activeTab = layout.tabs.find((tab) => tab.id === layout.selected);
  return <div ref={root} className="flex h-full min-h-0 min-w-0 flex-col [&_[data-panel][hidden]]:hidden!" data-testid="local-side-workspace">
    <ResizablePanelGroup orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="side-main" minSize="32%" hidden={!mainVisible}><div className="h-full min-w-0">{props.children(mainVisible)}</div></ResizablePanel>
      {sideVisible && mainVisible && <ResizableHandle aria-label={props.chinese ? "调整右侧面板宽度" : "Resize right workspace"} onPointerDown={() => { document.documentElement.dataset.sideDragging = "true"; const end = () => { delete document.documentElement.dataset.sideDragging; window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); }; window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true }); window.addEventListener("blur", end, { once: true }); }} />}
      <ResizablePanel id="side-resources" defaultSize="46%" minSize="30%" hidden={!sideVisible}>
        <div className="flex h-full min-h-0 min-w-0 flex-col border-l bg-background" aria-label={props.chinese ? "右侧工作区" : "Right workspace"}>
          <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
            {!mainVisible && <IconButton label={props.chinese ? "返回主对话" : "Return to main chat"} onClick={() => { setMaximized(false); if (narrow) setLayout((current) => ({ ...current, open: false })); }}><ArrowLeft /></IconButton>}
            <div role="tablist" aria-label={props.chinese ? "右侧内容" : "Workspace tabs"} className="flex min-w-0 flex-1 overflow-x-auto">
              {layout.tabs.map((tab) => <div key={tab.id} className={`flex min-w-24 max-w-48 shrink-0 items-center rounded-t-md border-b-2 ${tab.id === layout.selected ? "border-foreground bg-surface-selected" : "border-transparent"}`}>
                <Button role="tab" id={`resource-tab-${tab.id}`} aria-selected={tab.id === layout.selected} aria-controls={`resource-content-${tab.id}`} tabIndex={tab.id === layout.selected ? 0 : -1} variant="ghost" size="sm" className="min-w-0 flex-1 justify-start rounded-none px-2 text-label" onClick={() => setLayout((current) => ({ ...current, selected: tab.id }))} onKeyDown={(event) => {
                  const index = layout.tabs.findIndex((item) => item.id === tab.id); const next = event.key === "ArrowRight" ? layout.tabs[(index + 1) % layout.tabs.length] : event.key === "ArrowLeft" ? layout.tabs[(index + layout.tabs.length - 1) % layout.tabs.length] : event.key === "Home" ? layout.tabs[0] : event.key === "End" ? layout.tabs.at(-1) : undefined;
                  if (next) { event.preventDefault(); setLayout((current) => ({ ...current, selected: next.id })); document.getElementById(`resource-tab-${next.id}`)?.focus(); }
                }}>{tab.kind === "side" ? <MessagesSquare className="size-4 shrink-0" /> : tab.kind === "web" ? <Globe className="size-4 shrink-0" /> : tab.location.kind === "directory" ? <FolderOpen className="size-4 shrink-0" /> : <File className="size-4 shrink-0" />}<span className="truncate" title={title(tab)}>{title(tab)}</span></Button>
                <IconButton label={`${props.chinese ? "关闭" : "Close"} ${title(tab)}`} className="shrink-0" onClick={() => close(tab.id)}><X className="size-3" /></IconButton>
              </div>)}
            </div>
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={props.chinese ? "添加右侧内容" : "Add workspace content"} />}><Plus /></DropdownMenuTrigger><DropdownMenuContent align="end">
              <DropdownMenuItem disabled={creating} onClick={() => { void createSide(); }}><MessagesSquare />{props.chinese ? "新建旁支" : "New side conversation"}</DropdownMenuItem><DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { void chooseFile("directory"); }}><FolderOpen />{props.chinese ? "打开文件夹" : "Open folder"}</DropdownMenuItem><DropdownMenuItem onClick={() => { void chooseFile("file"); }}><File />{props.chinese ? "打开文件" : "Open file"}</DropdownMenuItem><DropdownMenuItem onClick={() => { setAddress(""); setAddressOpen(true); }}><Globe />{props.chinese ? "打开网页" : "Open webpage"}</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu>
            <IconButton label={maximized ? (props.chinese ? "恢复并排显示" : "Restore split view") : (props.chinese ? "展开右侧面板" : "Expand right workspace")} onClick={() => setMaximized(!maximized)}>{maximized ? <Minimize2 /> : <Maximize2 />}</IconButton><IconButton label={props.chinese ? "关闭右侧面板" : "Close right workspace"} onClick={() => setLayout((current) => ({ ...current, open: false }))}><X /></IconButton>
          </div>
          {error && <div role="alert" className="flex items-center justify-between border-b px-3 py-2 text-caption text-destructive"><span>{error}</span><IconButton label={props.chinese ? "关闭错误提示" : "Dismiss error"} onClick={() => setError("")}><X /></IconButton></div>}
          {!activeTab && <div className="flex flex-1 flex-col items-center justify-center gap-4 text-body text-muted-foreground"><PanelRightOpen className="size-8" /><span>{props.chinese ? "在这里继续旁支对话，或查看文件和网页" : "Continue a side chat or inspect files and webpages here"}</span><Button variant="outline" disabled={creating} onClick={() => { void createSide(); }}><Plus className="size-4" />{props.chinese ? "新建旁支" : "New side conversation"}</Button></div>}
          {layout.tabs.map((tab) => <section key={tab.id} role="tabpanel" id={`resource-content-${tab.id}`} aria-labelledby={`resource-tab-${tab.id}`} hidden={layout.selected !== tab.id} className="min-h-0 flex-1 overflow-hidden">
            {tab.kind === "side" ? <SideConversation sessionId={tab.sessionId} {...props} onSelectSource={(id, turnId, quote) => { setMaximized(false); if (narrow) setLayout((current) => ({ ...current, open: false })); props.onSelectSource(id, turnId, quote); }} onSide={openSide} onResource={openResource} visible={props.active && sideVisible && layout.selected === tab.id} /> : tab.kind === "web" ? <WebResourcePreview id={tab.id} url={tab.url} scope={props.scope} active={props.active && sideVisible && layout.selected === tab.id} chinese={props.chinese} onChange={(url, title) => setLayout((current) => ({ ...current, tabs: current.tabs.map((item) => item.id === tab.id && item.kind === "web" ? { ...item, url, title } : item) }))} onReference={(url, title) => { props.onReference(`[${title}](${url})`); if (narrow) setLayout((current) => ({ ...current, open: false })); }} /> : <div className="flex h-full min-h-0 min-w-0">
              {tab.location.kind === "directory" && <div className="w-40 shrink-0 overflow-auto border-r p-1 text-label"><PreviewFolder location={tab.location} selected={tab.selected?.path} scope={props.scope} sessionId={tab.sourceId} chinese={props.chinese} onSelect={(selected) => setLayout((current) => ({ ...current, tabs: current.tabs.map((item) => item.id === tab.id && item.kind === "file" ? { ...item, selected, line: undefined } : item) }))} /></div>}
              <div className="min-w-0 flex-1">{tab.selected || tab.location.kind === "file" ? <LocalFilePreview key={(tab.selected ?? tab.location).path} location={tab.selected ?? tab.location} scope={props.scope} sessionId={tab.sourceId} chinese={props.chinese} line={tab.line} /> : <div className="flex h-full items-center justify-center text-body text-muted-foreground">{props.chinese ? "选择文件进行预览" : "Choose a file to preview"}</div>}</div>
            </div>}
          </section>)}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
    <Dialog open={addressOpen} onOpenChange={setAddressOpen}><DialogContent><form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); try { const url = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`); if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error(props.chinese ? "请输入 HTTP 或 HTTPS 地址" : "Enter an HTTP or HTTPS address"); add({ id: `web:${crypto.randomUUID()}`, kind: "web", url: url.href }); setAddressOpen(false); } catch (error) { showError(error); } }}><DialogHeader><DialogTitle>{props.chinese ? "打开网页" : "Open webpage"}</DialogTitle></DialogHeader><label className="grid gap-2 text-label">{props.chinese ? "网页地址" : "Webpage address"}<Input autoFocus value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://" required /></label><DialogFooter><Button type="button" variant="outline" onClick={() => setAddressOpen(false)}>{props.chinese ? "取消" : "Cancel"}</Button><Button type="submit">{props.chinese ? "打开" : "Open"}</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
});

function SideConversation(props: Props & { sessionId: string; onSide(id: string): void; onResource(id: string, url: string): Promise<void>; visible: boolean }) {
  const queryClient = useQueryClient();
  const latest = useRef(props); latest.current = props;
  const session = props.sessions.find((entry) => entry.id === props.sessionId);
  const [starting, setStarting] = useState(false);
  const factory = useCallback((options: ParentServiceOptions) => createLocalConversationParentService({ ...options, storagePrefix: `side:${props.sessionId}:`, onLocalSelect: (id) => { if (id && id !== props.sessionId) latest.current.onSide(id); }, onOpenSide: (id) => latest.current.onSide(id), onOpenResource: (id, url) => { void latest.current.onResource(id, url).catch((error: unknown) => latest.current.onShowMessage(error instanceof Error ? error.message : String(error), "error")); }, onLocateSource: (id, turnId, quote) => latest.current.onSelectSource(id, turnId, quote) }, window.desktopAPI.localConversations), [props.sessionId]);
  return <div className="flex h-full min-h-0 flex-col">
    {session?.side && <div className="shrink-0 border-b px-3 py-3 text-caption text-muted-foreground"><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{props.chinese ? "来自主对话" : "From main chat"} · {props.sessions.find((entry) => entry.id === session.side!.sourceId)?.title}</span><Button variant="link" size="xs" onClick={() => props.onSelectSource(session.side!.sourceId, session.side!.turnId, session.side!.quote)}><ArrowLeft className="size-3.5" />{props.chinese ? "定位来源" : "Locate source"}</Button></div>{session.side.quote && <blockquote className="mt-2 max-h-28 overflow-auto border-l-2 pl-3 text-body text-foreground">{session.side.quote}</blockquote>}{session.side.pending && <Button className="mt-2" variant="outline" size="sm" disabled={starting} onClick={() => {
      setStarting(true); const service = factory({ queryClient, resolveAvatar: (url) => url, workspaceId: props.scope.workspaceId, workspaceSlug: props.slug, userId: props.scope.userId, isCurrent: () => useAuthStore.getState().user?.id === props.scope.userId && getCurrentWsId() === props.scope.workspaceId, onSelectSession: () => {}, onOpenTask: props.onOpenTask, onShowMessage: props.onShowMessage });
      void service.request("host.startSide", { sessionId: session.id }).catch((error: unknown) => props.onShowMessage(error instanceof Error ? error.message : String(error), "error")).finally(() => { service.dispose(); setStarting(false); });
    }}>{props.chinese ? "执行转入的消息" : "Run transferred message"}</Button>}</div>}
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TuttiAgentGuiPanel serviceFactory={factory} workspaceId={props.scope.workspaceId} workspaceSlug={props.slug} userId={props.scope.userId} activeSessionId={props.sessionId} selectedAgentId={localTargetId(session?.provider ?? props.provider)} active={props.visible} onRestoreDraftApplied={() => {}} onSelectSession={() => {}} onOpenTask={props.onOpenTask} onShowMessage={props.onShowMessage} />
      {session && session.turns.length === 0 && !session.side?.pending && <div className="pointer-events-none absolute inset-x-4 top-1/3 flex flex-col items-center gap-3 text-center text-body text-muted-foreground"><MessagesSquare className="size-6" aria-hidden="true" /><p>{props.chinese ? (session.side?.quote ? "围绕选中的内容继续提问" : "在旁支里继续探索") : (session.side?.quote ? "Ask a follow-up about your selection" : "Continue exploring in this side conversation")}</p></div>}
    </div>
  </div>;
}
