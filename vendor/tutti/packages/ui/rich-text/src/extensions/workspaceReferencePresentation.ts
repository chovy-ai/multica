export interface WorkspaceReferencePresentation {
  displayLabel: string;
  fullPath: string;
}

export function getWorkspaceReferencePresentation(
  label: string,
  path: string
): WorkspaceReferencePresentation {
  const displayLabel = normalizeReferenceLabel(label, path);
  const fullPath = normalizeFullPath(path);

  return {
    displayLabel,
    fullPath
  };
}

function normalizeReferenceLabel(label: string, path: string): string {
  const trimmedLabel = label.trim();

  if (trimmedLabel !== "") {
    return trimmedLabel;
  }

  return getPathBasename(path) || path.trim();
}

function normalizeFullPath(path: string): string {
  return trimTrailingSeparators(path.trim());
}

function getPathBasename(path: string): string {
  const normalizedPath = trimTrailingSeparators(path.trim());

  if (normalizedPath === "" || isPathRoot(normalizedPath)) {
    return normalizedPath;
  }

  const segments = normalizedPath.split(/[\\/]+/).filter(Boolean);

  return segments.at(-1) ?? "";
}

function trimTrailingSeparators(path: string): string {
  if (path === "") {
    return "";
  }

  if (isPathRoot(path)) {
    return path;
  }

  return path.replace(/[\\/]+$/, "");
}

function isPathRoot(path: string): boolean {
  return (
    path === "/" ||
    path === "\\" ||
    path === "//" ||
    path === "\\\\" ||
    /^[A-Za-z]:[\\/]?$/.test(path)
  );
}
