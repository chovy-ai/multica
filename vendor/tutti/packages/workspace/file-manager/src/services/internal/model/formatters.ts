import { formatTuttiShortDateTime } from "@tutti-os/ui-system/date-format";
import type { TuttiDateLocale } from "@tutti-os/ui-system/date-format";

export function formatWorkspaceFileBytes(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes)) {
    return "--";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

export function formatWorkspaceFileModifiedTime(
  mtimeMs: number | null,
  locale?: TuttiDateLocale
): string {
  if (mtimeMs === null || !Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return "--";
  }
  return formatTuttiShortDateTime(mtimeMs, locale);
}

export function splitWorkspaceFileName(name: string): {
  end: string;
  start: string;
} {
  const extensionIndex = name.lastIndexOf(".");
  const hasExtension = extensionIndex > 0 && extensionIndex < name.length - 1;
  if (hasExtension) {
    return {
      end: name.slice(extensionIndex),
      start: name.slice(0, extensionIndex)
    };
  }
  if (name.length <= 24) {
    return { end: "", start: name };
  }
  return {
    end: name.slice(-10),
    start: name.slice(0, -10)
  };
}
