// Give image thumbnails enough room to be recognizable while keeping dense rows.
const workspaceFileManagerIconGridIconSizePx = 84;
const workspaceFileManagerIconGridTileMinWidthPx = 136;
const workspaceFileManagerIconGridTileMaxWidthPx = 148;

export const workspaceFileManagerIconGridLayout = {
  iconSizePx: workspaceFileManagerIconGridIconSizePx,
  tileMaxWidthPx: workspaceFileManagerIconGridTileMaxWidthPx,
  tileMinWidthPx: workspaceFileManagerIconGridTileMinWidthPx
} as const;

export function workspaceFileManagerIconGridIconClassName(): string {
  return "size-[84px]";
}

export function workspaceFileManagerIconGridFrameClassName(): string {
  return "size-[92px]";
}
