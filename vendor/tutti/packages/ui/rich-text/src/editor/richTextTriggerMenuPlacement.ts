export type RichTextTriggerMenuPlacement =
  | "bottom-start"
  | "top-start"
  | "auto-start";

export type RichTextTriggerMenuAnchor = "cursor" | "editor";

export interface RichTextTriggerMenuSize {
  width: number;
  height: number;
}

export interface RichTextTriggerMenuRect {
  left: number;
  top: number;
  bottom: number;
}

export interface RichTextTriggerMenuEditorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

interface RichTextTriggerResolvedPointMenuPlacement {
  type: "point";
  alignY: "start" | "end";
  boundaryPoint?: {
    x: number;
    y: number;
  };
  point: {
    x: number;
    y: number;
  };
  width?: number;
}

export type RichTextTriggerResolvedMenuPlacement =
  RichTextTriggerResolvedPointMenuPlacement;

export const richTextTriggerMenuEstimatedSize = {
  width: 360,
  height: 256
} as const satisfies RichTextTriggerMenuSize;

const richTextTriggerMenuViewportPadding = 12;

export function resolveRichTextTriggerMenuPlacement(options: {
  cursorRect: RichTextTriggerMenuRect;
  editorRect?: RichTextTriggerMenuEditorRect;
  estimatedSize?: RichTextTriggerMenuSize;
  menuAnchor?: RichTextTriggerMenuAnchor;
  menuOffset: number;
  menuPlacement: RichTextTriggerMenuPlacement;
  viewportWidth?: number;
  viewportHeight: number;
}): RichTextTriggerResolvedMenuPlacement {
  const {
    cursorRect,
    editorRect,
    estimatedSize = richTextTriggerMenuEstimatedSize,
    menuAnchor = "cursor",
    menuOffset,
    menuPlacement,
    viewportWidth = 1280,
    viewportHeight
  } = options;

  if (menuAnchor === "editor" && editorRect) {
    return resolveEditorAnchoredPlacement({
      editorRect,
      estimatedSize,
      menuOffset,
      menuPlacement,
      viewportHeight,
      viewportWidth
    });
  }

  if (menuPlacement === "top-start") {
    return resolveTopStartPlacement(cursorRect, menuOffset);
  }

  if (menuPlacement === "auto-start") {
    const bottomPlacement = resolveBottomStartPlacement(cursorRect, menuOffset);
    const topPlacement = resolveTopStartPlacement(cursorRect, menuOffset);
    const bottomFits =
      bottomPlacement.point.y + estimatedSize.height <=
      viewportHeight - richTextTriggerMenuViewportPadding;
    const topFits =
      topPlacement.point.y - estimatedSize.height >=
      richTextTriggerMenuViewportPadding;

    if (!bottomFits && topFits) {
      return topPlacement;
    }
  }

  return resolveBottomStartPlacement(cursorRect, menuOffset);
}

function resolveEditorAnchoredPlacement(options: {
  editorRect: RichTextTriggerMenuEditorRect;
  estimatedSize: RichTextTriggerMenuSize;
  menuOffset: number;
  menuPlacement: RichTextTriggerMenuPlacement;
  viewportHeight: number;
  viewportWidth: number;
}): RichTextTriggerResolvedPointMenuPlacement {
  const {
    editorRect,
    estimatedSize,
    menuOffset,
    menuPlacement,
    viewportHeight,
    viewportWidth
  } = options;
  const maxWidth = Math.max(
    0,
    viewportWidth - richTextTriggerMenuViewportPadding * 2
  );
  const width = Math.min(editorRect.width, maxWidth);
  const left = Math.max(
    richTextTriggerMenuViewportPadding,
    Math.min(
      editorRect.left,
      viewportWidth - richTextTriggerMenuViewportPadding - width
    )
  );
  const spaceAbove =
    editorRect.top - menuOffset - richTextTriggerMenuViewportPadding;
  const spaceBelow =
    viewportHeight -
    editorRect.bottom -
    menuOffset -
    richTextTriggerMenuViewportPadding;
  const placeAbove =
    menuPlacement === "top-start" ||
    (menuPlacement === "auto-start" &&
      spaceBelow < estimatedSize.height &&
      spaceAbove > spaceBelow);

  return {
    type: "point",
    alignY: placeAbove ? "end" : "start",
    boundaryPoint: {
      x: Math.round(editorRect.left + editorRect.width / 2),
      y: Math.round((editorRect.top + editorRect.bottom) / 2)
    },
    point: {
      x: Math.round(left),
      y: Math.round(
        placeAbove
          ? editorRect.top - menuOffset
          : editorRect.bottom + menuOffset
      )
    },
    width: Math.round(width)
  };
}

function resolveBottomStartPlacement(
  cursorRect: RichTextTriggerMenuRect,
  menuOffset: number
): RichTextTriggerResolvedPointMenuPlacement {
  return {
    type: "point",
    alignY: "start",
    point: {
      x: cursorRect.left,
      y: cursorRect.bottom + menuOffset
    }
  };
}

function resolveTopStartPlacement(
  cursorRect: RichTextTriggerMenuRect,
  menuOffset: number
): RichTextTriggerResolvedPointMenuPlacement {
  return {
    type: "point",
    alignY: "end",
    point: {
      x: cursorRect.left,
      y: cursorRect.top - menuOffset
    }
  };
}
