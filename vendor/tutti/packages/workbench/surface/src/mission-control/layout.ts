import type { WorkbenchFrame, WorkbenchNode } from "../core/types.ts";

export const WORKBENCH_MISSION_CONTROL_GAP_PX = 20;

export interface WorkbenchMissionControlPreviewLayoutItem<TData = unknown> {
  frame: WorkbenchFrame;
  node: WorkbenchNode<TData>;
}

export function orderWorkbenchNodesForMissionControl<TData>(
  nodes: readonly WorkbenchNode<TData>[]
): WorkbenchNode<TData>[] {
  return [...nodes].sort((left, right) => {
    const topDelta = left.frame.y - right.frame.y;
    if (Math.abs(topDelta) > 24) {
      return topDelta;
    }

    const leftDelta = left.frame.x - right.frame.x;
    if (leftDelta !== 0) {
      return leftDelta;
    }

    return left.id.localeCompare(right.id);
  });
}

export function resolveWorkbenchMissionControlPreviewLayout<TData>(input: {
  container: WorkbenchFrame;
  gap?: number;
  nodes: readonly WorkbenchNode<TData>[];
}): WorkbenchMissionControlPreviewLayoutItem<TData>[] {
  const nodes = orderWorkbenchNodesForMissionControl(input.nodes);
  if (nodes.length === 0) {
    return [];
  }

  const gap = input.gap ?? WORKBENCH_MISSION_CONTROL_GAP_PX;
  const container = input.container;
  const scale = resolveBestPreviewScale(nodes, container, gap);
  if (scale <= 0) {
    return [];
  }
  const rows = packNodesIntoRows(nodes, container.width, gap, scale);
  if (rows.length === 0) {
    return [];
  }

  const totalHeight =
    rows.reduce((sum, row) => sum + row.height, 0) +
    Math.max(0, rows.length - 1) * gap;
  const startY = container.y + (container.height - totalHeight) / 2;
  const layout: WorkbenchMissionControlPreviewLayoutItem<TData>[] = [];
  let cursorY = startY;

  rows.forEach((row) => {
    let cursorX = container.x + (container.width - row.width) / 2;

    row.items.forEach((item) => {
      layout.push({
        frame: {
          x: cursorX,
          y: cursorY + (row.height - item.height) / 2,
          width: item.width,
          height: item.height
        },
        node: item.node
      });
      cursorX += item.width + gap;
    });

    cursorY += row.height + gap;
  });

  return layout;
}

function resolveBestPreviewScale<TData>(
  nodes: readonly WorkbenchNode<TData>[],
  container: WorkbenchFrame,
  gap: number
): number {
  if (container.width <= 0 || container.height <= 0) {
    return 0;
  }

  let lowerBound = 0;
  let upperBound = 1;

  while (
    scaleFitsInsideContainer(
      nodes,
      container.width,
      container.height,
      gap,
      upperBound
    )
  ) {
    lowerBound = upperBound;
    upperBound *= 2;

    if (upperBound > 64) {
      return lowerBound;
    }
  }

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const next = (lowerBound + upperBound) / 2;

    if (
      scaleFitsInsideContainer(
        nodes,
        container.width,
        container.height,
        gap,
        next
      )
    ) {
      lowerBound = next;
    } else {
      upperBound = next;
    }
  }

  return lowerBound;
}

function scaleFitsInsideContainer<TData>(
  nodes: readonly WorkbenchNode<TData>[],
  containerWidth: number,
  containerHeight: number,
  gap: number,
  scale: number
): boolean {
  if (scale <= 0) {
    return false;
  }

  const rows = packNodesIntoRows(nodes, containerWidth, gap, scale);
  if (rows.length === 0) {
    return false;
  }

  const totalHeight =
    rows.reduce((sum, row) => sum + row.height, 0) +
    Math.max(0, rows.length - 1) * gap;
  return totalHeight <= containerHeight;
}

function packNodesIntoRows<TData>(
  nodes: readonly WorkbenchNode<TData>[],
  containerWidth: number,
  gap: number,
  scale: number
): PackedPreviewRow<TData>[] {
  const rows: PackedPreviewRow<TData>[] = [];
  let currentRow: PackedPreviewRow<TData> | null = null;

  const commitCurrentRow = () => {
    if (currentRow && currentRow.items.length > 0) {
      rows.push(currentRow);
    }
  };

  for (const node of nodes) {
    const width = Math.max(1, node.frame.width * scale);
    const height = Math.max(1, node.frame.height * scale);

    if (width > containerWidth) {
      return [];
    }

    if (!currentRow) {
      currentRow = {
        height,
        items: [{ height, node, width }],
        width
      };
      continue;
    }

    const nextWidth = currentRow.width + gap + width;
    if (nextWidth > containerWidth) {
      commitCurrentRow();
      currentRow = {
        height,
        items: [{ height, node, width }],
        width
      };
      continue;
    }

    currentRow.items.push({ height, node, width });
    currentRow.width = nextWidth;
    currentRow.height = Math.max(currentRow.height, height);
  }

  commitCurrentRow();

  return rows;
}

interface PackedPreviewRow<TData> {
  height: number;
  items: Array<{
    height: number;
    node: WorkbenchNode<TData>;
    width: number;
  }>;
  width: number;
}
