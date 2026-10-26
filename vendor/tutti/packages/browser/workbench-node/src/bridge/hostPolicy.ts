function normalizeHostPattern(pattern: string): string | null {
  const trimmed = pattern.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function matchesHostPattern(host: string, pattern: string): boolean {
  const normalizedPattern = normalizeHostPattern(pattern);
  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern === "*") {
    return true;
  }

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  if (normalizedPattern.endsWith(".*")) {
    return host.startsWith(normalizedPattern.slice(0, -1));
  }

  return host === normalizedPattern;
}

export function isBrowserNodeBridgeHostAllowed(
  url: string,
  hostPatterns: readonly string[]
): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.trim().toLowerCase();
  if (host.length === 0) {
    return false;
  }

  return hostPatterns.some((pattern) => matchesHostPattern(host, pattern));
}
