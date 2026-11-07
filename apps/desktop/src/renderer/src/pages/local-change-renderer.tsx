import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChevronRight, File, Folder } from "lucide-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { useTheme } from "@multica/ui/components/common/theme-provider";
import type { ConversationChangeDetail, ConversationFileResource } from "@multica/core/local-conversation/resources";
import { usePersistCallback } from "@multica/ui/hooks/use-persist-callback";

const highlighterOptions = { theme: { light: "github-light" as const, dark: "github-dark" as const } };
const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 1 };
const treeCSS = `:host { --trees-accent-override:var(--ring); --trees-bg-override: var(--surface); --trees-fg-override: var(--foreground); --trees-selected-bg-override: var(--surface-selected); --trees-selected-fg-override: var(--foreground); --trees-hover-bg-override: var(--surface-hover); --trees-border-color-override: var(--surface-border); --trees-font-size:var(--text-label); --trees-font-family:inherit; }`;
const diffCSS = `:host { --diffs-font-size:var(--text-label); --diffs-line-height:var(--text-label--line-height); --diffs-bg:var(--surface); --diffs-fg:var(--foreground); --diffs-fg-number:var(--muted-foreground); --diffs-bg-addition-override:color-mix(in srgb,var(--success) 10%,var(--surface)); --diffs-bg-deletion-override:color-mix(in srgb,var(--destructive) 10%,var(--surface)); }`;
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

export function ChangeDiff({ detail, split, wrap }: { detail: ConversationChangeDetail; split: boolean; wrap: boolean }) {
  const { resolvedTheme } = useTheme();
  const parsed = useMemo(() => {
    try { return parsePatchFiles(detail.patch).flatMap(patch => patch.files)[0]; } catch { return undefined; }
  }, [detail.patch]);
  const loadFiles = usePersistCallback(async () => ({ oldFile: { name: detail.file.old_path ?? detail.file.path, contents: detail.before }, newFile: { name: detail.file.path, contents: detail.after } }));
  if (!parsed) return null;
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
    <FileDiff fileDiff={parsed} options={{ diffStyle: split ? "split" : "unified", overflow: wrap ? "wrap" : "scroll", themeType: resolvedTheme === "dark" ? "dark" : "light", theme: { light: "github-light", dark: "github-dark" }, disableFileHeader: true, unsafeCSS: diffCSS, loadDiffFiles: loadFiles, tokenizeMaxLineLength: 20000 }} />
  </WorkerPoolContextProvider>;
}
