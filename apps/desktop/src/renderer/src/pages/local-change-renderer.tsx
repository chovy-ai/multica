import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChevronRight, File, Folder, Loader2 } from "lucide-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { parsePatchFiles, type CodeViewDiffItem } from "@pierre/diffs";
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import type { ConversationChangeDetail, ConversationFileResource } from "@multica/core/local-conversation/resources";
import { usePersistCallback } from "@multica/ui/hooks/use-persist-callback";

const highlighterOptions = { theme: { light: "github-light" as const, dark: "github-dark" as const } };
const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 1 };
const treeCSS = `:host { --trees-accent-override:var(--ring); --trees-bg-override: var(--surface); --trees-fg-override: var(--foreground); --trees-selected-bg-override: var(--surface-selected); --trees-selected-fg-override: var(--foreground); --trees-hover-bg-override: var(--surface-hover); --trees-border-color-override: var(--surface-border); --trees-font-size:var(--text-label); --trees-font-family:inherit; }`;
const diffCSS = `:host { --diffs-font-size:var(--text-label); --diffs-line-height:var(--text-label--line-height); --diffs-bg:var(--surface); --diffs-fg:var(--foreground); --diffs-fg-number:var(--muted-foreground); --diffs-bg-addition-override:color-mix(in srgb,var(--success) 10%,var(--surface)); --diffs-bg-deletion-override:color-mix(in srgb,var(--destructive) 10%,var(--surface)); }`;
// Adapted from T3 Code's styled CodeView; see the shipped T3 MIT notice.
const virtualDiffCSS = `${diffCSS}
[data-diff-type="split"][data-overflow="wrap"] { --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr); }
`;
// Match --text-label--line-height and Pierre's unmodified file padding.
const itemMetrics = { lineHeight: 18, diffHeaderHeight: 0, paddingTop: 8, paddingBottom: 8 };
const viewLayout = { paddingTop: 0, paddingBottom: 0, gap: 0 };
const symbol = (id: string, element: React.ReactElement) => renderToStaticMarkup(element).replace("<svg", `<symbol id="${id}"`).replace("</svg>", "</symbol>");
const icons = { set: "none" as const, colored: false,
  spriteSheet: `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;overflow:hidden" aria-hidden="true">${symbol("multica-file", <File />)}${symbol("multica-folder", <Folder />)}${symbol("multica-chevron", <ChevronRight />)}</svg>`,
  remap: { file: "multica-file", folder: "multica-folder", chevron: "multica-chevron" } };

export function ChangeTree({ files, selected, onSelect, label }: { files: ConversationFileResource[]; selected?: string; onSelect(id: string): void; label: string }) {
  const multipleRoots = new Set(files.map(file => file.cwd)).size > 1;
  const pathOf = useCallback((file: ConversationFileResource) => `${multipleRoots ? `${file.cwd.replace(/^[/\\]+/, "")}/` : ""}${file.path}`, [multipleRoots]);
  const paths = useMemo(() => files.map(pathOf), [files, pathOf]);
  const synchronizingSelection = useRef(false);
  const select = usePersistCallback((paths: readonly string[]) => {
    if (synchronizingSelection.current) return;
    const current = files.find(file => file.id === selected);
    const next = paths.find(path => !current || path !== pathOf(current)) ?? paths[0];
    const file = files.find(file => pathOf(file) === next);
    if (file && file.id !== selected) onSelect(file.id);
  });
  const decorate = usePersistCallback(({ item }: { item: { path: string } }) => { const file = files.find(file => pathOf(file) === item.path); return file ? { text: ({added:"A",deleted:"D",renamed:"R",modified:"M"} as Record<string,string>)[file.kind] ?? "?", title: `${file.cwd}/${file.path}` } : null; });
  const { model } = useFileTree({ paths, initialExpansion: "open", dragAndDrop: false, renaming: false, icons, onSelectionChange: select, renderRowDecoration: decorate, unsafeCSS: treeCSS });
  useEffect(() => { model.resetPaths(paths); }, [model, paths]);
  useEffect(() => {
    const file = files.find(file => file.id === selected);
    const path = file ? pathOf(file) : undefined;
    // The resource tab owns one selected file; Pierre's item.select() adds to
    // its selection, so synchronize without treating these updates as input.
    synchronizingSelection.current = true;
    try {
      for (const previous of model.getSelectedPaths()) if (previous !== path) model.getItem(previous)?.deselect();
      if (path) model.getItem(path)?.select();
    } finally { synchronizingSelection.current = false; }
  }, [model, selected, files, pathOf]);
  return <FileTree model={model} className="h-full min-w-0" aria-label={label} />;
}

export function ChangeDiff({ detail, file, split, wrap }: { detail?: ConversationChangeDetail; file: ConversationFileResource; split: boolean; wrap: boolean }) {
  const instanceId = useId();
  const view = useRef<CodeViewHandle<undefined, undefined>>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const positions = useRef(new Map<string, number>());
  const fileKey = JSON.stringify([file.cwd, file.id]);
  const setContainer = usePersistCallback((element: HTMLDivElement | null) => { scroller.current = element; if (element) element.tabIndex = 0; });
  const { resolvedTheme } = useTheme();
  const patch = detail?.patch;
  const parsed = useMemo(() => {
    try { return patch ? parsePatchFiles(patch).flatMap(patch => patch.files)[0] : undefined; } catch { return undefined; }
  }, [patch]);
  const items = useMemo<CodeViewDiffItem[]>(() => parsed ? [{
    id: JSON.stringify([instanceId, fileKey]),
    type: "diff", fileDiff: parsed, version: detail?.revision, edit: false,
  }] : [], [instanceId, fileKey, detail?.revision, parsed]);
  const loadFiles = usePersistCallback(async () => {
    if (!detail) throw new Error("Change detail is updating");
    return { oldFile: { name: detail.file.old_path ?? detail.file.path, contents: detail.before }, newFile: { name: detail.file.path, contents: detail.after } };
  });
  const restorePosition = usePersistCallback(() => view.current?.scrollTo({ type: "position", position: positions.current.get(fileKey) ?? 0 }));
  useLayoutEffect(() => {
    const element = scroller.current;
    const readingPositions = positions.current;
    if (parsed) restorePosition();
    // Capture before CodeView installs the next version or clears pending data.
    return () => { if (parsed && element) readingPositions.set(fileKey, element.scrollTop); };
  }, [fileKey, detail?.revision, parsed, restorePosition]);
  return <div className="relative h-full min-h-0 min-w-0" aria-busy={!detail}>
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <CodeView ref={view} items={items} containerRef={setContainer} className="conversation-change-code-view h-full min-h-0 min-w-0 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" options={{ diffStyle: split ? "split" : "unified", overflow: wrap ? "wrap" : "scroll", themeType: resolvedTheme === "dark" ? "dark" : "light", theme: highlighterOptions.theme, disableFileHeader: true, unsafeCSS: virtualDiffCSS, loadDiffFiles: loadFiles, tokenizeMaxLineLength: 20000, itemMetrics, layout: viewLayout }} />
    </WorkerPoolContextProvider>
    {!detail && <div role="status" className="absolute inset-0 flex items-center justify-center"><Loader2 className="size-4 animate-spin" /></div>}
  </div>;
}
