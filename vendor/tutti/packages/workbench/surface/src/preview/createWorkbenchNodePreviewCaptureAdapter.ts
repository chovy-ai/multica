import type { WorkbenchNode } from "../core/types.ts";
import type {
  WorkbenchNodePreviewImages,
  WorkbenchNodePreviewImagesCapture
} from "../react/nodePreviewCapture.ts";

export interface WorkbenchNodePreviewCaptureRectInput {
  maxHeight: number;
  maxWidth: number;
  nodeId: string;
  rect: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
}

export interface WorkbenchNodePreviewCaptureDiagnostic {
  details: Record<string, unknown>;
  event:
    | "capture_failed"
    | "capture_requested"
    | "capture_resolved"
    | "capture_skipped"
    | "capture_started"
    | "capture_timed_out";
  level: "debug" | "info" | "warn";
}

export interface WorkbenchNodePreviewCaptureAdapterOptions<TData = unknown> {
  captureRect: (
    input: WorkbenchNodePreviewCaptureRectInput
  ) => Promise<WorkbenchNodePreviewImages | null>;
  diagnostics?: (diagnostic: WorkbenchNodePreviewCaptureDiagnostic) => void;
  maxHeight: number;
  maxWidth: number;
  resolveDiagnosticContext?: (
    node: WorkbenchNode<TData>
  ) => Record<string, unknown>;
  timeoutMs?: number;
}

const defaultCaptureTimeoutMs = 2_500;

export function createWorkbenchNodePreviewCaptureAdapter<TData = unknown>(
  options: WorkbenchNodePreviewCaptureAdapterOptions<TData>
): WorkbenchNodePreviewImagesCapture<TData> {
  const {
    captureRect,
    diagnostics,
    maxHeight,
    maxWidth,
    resolveDiagnosticContext,
    timeoutMs = defaultCaptureTimeoutMs
  } = options;

  return async (node) => {
    const diagnosticContext = resolveDiagnosticContext?.(node) ?? {};
    const emit = (diagnostic: WorkbenchNodePreviewCaptureDiagnostic): void => {
      emitDiagnostic(diagnostics, {
        ...diagnostic,
        details: { ...diagnosticContext, ...diagnostic.details }
      });
    };
    emit({
      details: {
        documentVisibilityState: document.visibilityState,
        isMinimized: node.isMinimized,
        nodeId: node.id
      },
      event: "capture_requested",
      level: "debug"
    });

    const skip = resolveCaptureTarget(node);
    if (skip.status === "skipped") {
      emit({
        details: {
          ...skip.details,
          nodeId: node.id,
          reason: skip.reason
        },
        event: "capture_skipped",
        level: skip.level
      });
      return null;
    }

    const rect = skip.target.getBoundingClientRect();
    if (!isUsableCaptureRect(rect)) {
      emit({
        details: {
          nodeId: node.id,
          reason: "capture_rect_invalid",
          rect: captureRectDetails(rect),
          viewport: { height: window.innerHeight, width: window.innerWidth }
        },
        event: "capture_skipped",
        level: "warn"
      });
      return null;
    }

    const input: WorkbenchNodePreviewCaptureRectInput = {
      maxHeight,
      maxWidth,
      nodeId: node.id,
      rect: captureRectDetails(rect)
    };
    emit({
      details: { ...input, timeoutMs },
      event: "capture_started",
      level: "info"
    });

    const startedAt = performance.now();
    const capturePromise = Promise.resolve().then(() => captureRect(input));
    const outcome = await resolveCaptureOutcome(capturePromise, timeoutMs);
    if (outcome.status === "timed_out") {
      emit({
        details: {
          durationMs: Math.round(performance.now() - startedAt),
          nodeId: node.id,
          timeoutMs
        },
        event: "capture_timed_out",
        level: "warn"
      });
      return null;
    }
    if (outcome.status === "failed") {
      emit({
        details: {
          durationMs: Math.round(performance.now() - startedAt),
          error: serializeError(outcome.error),
          nodeId: node.id
        },
        event: "capture_failed",
        level: "warn"
      });
      return null;
    }

    emit({
      details: {
        dockPreviewImageUrlLength:
          outcome.previewImages?.dockPreviewImageUrl?.length ?? 0,
        durationMs: Math.round(performance.now() - startedAt),
        genieImageUrlLength: outcome.previewImages?.genieImageUrl?.length ?? 0,
        hasResult: outcome.previewImages !== null,
        nodeId: node.id
      },
      event: "capture_resolved",
      level: outcome.previewImages ? "info" : "warn"
    });
    return outcome.previewImages;
  };
}

function resolveCaptureTarget<TData>(node: WorkbenchNode<TData>):
  | { status: "ready"; target: HTMLElement }
  | {
      details?: Record<string, unknown>;
      level: "debug" | "warn";
      reason:
        | "document_not_visible"
        | "node_minimized"
        | "window_element_missing"
        | "window_not_focused";
      status: "skipped";
    } {
  if (node.isMinimized) {
    return { level: "debug", reason: "node_minimized", status: "skipped" };
  }
  if (document.visibilityState !== "visible") {
    return {
      details: { documentVisibilityState: document.visibilityState },
      level: "debug",
      reason: "document_not_visible",
      status: "skipped"
    };
  }

  const windowElement =
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-workbench-window-id]")
    ).find((candidate) => candidate.dataset.workbenchWindowId === node.id) ??
    null;
  if (!windowElement) {
    return {
      level: "warn",
      reason: "window_element_missing",
      status: "skipped"
    };
  }
  if (windowElement.dataset.focused !== "true") {
    return {
      details: { focused: windowElement.dataset.focused ?? null },
      level: "debug",
      reason: "window_not_focused",
      status: "skipped"
    };
  }

  return {
    status: "ready",
    target:
      windowElement.querySelector<HTMLElement>(
        '[data-workbench-window-capture="true"]'
      ) ??
      windowElement.querySelector<HTMLElement>(".workbench-window") ??
      windowElement
  };
}

function isUsableCaptureRect(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.left + rect.width <= window.innerWidth &&
    rect.top + rect.height <= window.innerHeight
  );
}

function captureRectDetails(rect: DOMRect): {
  height: number;
  width: number;
  x: number;
  y: number;
} {
  return {
    height: rect.height,
    width: rect.width,
    x: rect.left,
    y: rect.top
  };
}

type CaptureOutcome =
  | { error: unknown; status: "failed" }
  | { previewImages: WorkbenchNodePreviewImages | null; status: "resolved" }
  | { status: "timed_out" };

async function resolveCaptureOutcome(
  capturePromise: Promise<WorkbenchNodePreviewImages | null>,
  timeoutMs: number
): Promise<CaptureOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settledCapture = capturePromise.then<CaptureOutcome, CaptureOutcome>(
    (previewImages) => ({ previewImages, status: "resolved" }),
    (error) => ({ error, status: "failed" })
  );
  const timeoutOutcome = new Promise<CaptureOutcome>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs);
  });
  return Promise.race([settledCapture, timeoutOutcome]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function emitDiagnostic(
  diagnostics: WorkbenchNodePreviewCaptureAdapterOptions<unknown>["diagnostics"],
  diagnostic: WorkbenchNodePreviewCaptureDiagnostic
): void {
  try {
    diagnostics?.(diagnostic);
  } catch {
    // Diagnostics must never affect preview capture.
  }
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
