// Lucide paths rendered into Pierre's supported sprite and CSS icon surfaces.
const svg = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;
const folder =
  '<path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>';
const open =
  '<path d="m6 14 1.5-3a2 2 0 0 1 1.8-1H20a2 2 0 0 1 2 2.5l-1.5 6a2 2 0 0 1-2 1.5H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1"/>';
const trash = '<path d="M3 6h18M19 6v14H5V6M9 6V3h6v3M10 10v6M14 10v6"/>';
const mask = (content: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg(content))}")`;
export const memoryFolderCSS = `
[data-item-type="folder"] [data-item-section="content"] { display:flex; align-items:center; gap:8px; }
[data-item-type="folder"] [data-item-section="content"]::before { content:""; width:16px; height:16px; flex-shrink:0; background:var(--muted-foreground); mask:${mask(folder)} center/contain no-repeat; }
[data-item-type="folder"][aria-expanded="true"] [data-item-section="content"]::before { mask-image:${mask(open)}; }
[data-item-path=".trash/"] [data-item-section="content"]::before { mask-image:${mask(trash)}; }
[data-item-type="file"] [data-item-section="icon"] { color:var(--brand); margin-left:16px; }
`;
export const memoryTreeIcons = {
  set: "minimal" as const,
  colored: false,
  spriteSheet: `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute"><symbol id="memory-file" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></g></symbol><symbol id="memory-index" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14m0-14C9 4 4 4 2 5v15c4-1 7 0 10 1 3-1 6-2 10-1V5c-2-1-7-1-10 2Z"/></g></symbol></svg>`,
  byFileExtension: { md: "memory-file" },
  byFileName: { "MEMORY.md": "memory-index" },
};
