export function shouldTrackDirectoryExpanded(input: {
  currentDirectoryPath: string;
  nextDirectoryPath: string;
}): boolean {
  return (
    normalizeDirectoryPath(input.currentDirectoryPath) !==
    normalizeDirectoryPath(input.nextDirectoryPath)
  );
}

function normalizeDirectoryPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
}
