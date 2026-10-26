const ALLOWED_WEBSITE_PROTOCOLS = new Set(["http:", "https:"]);
export const DEFAULT_WEBSITE_NODE_URL = "https://www.google.com/";
const GOOGLE_SEARCH_BASE_URL = "https://www.google.com/search";
const LIKELY_HOST_PATTERN =
  /^(localhost|(\d{1,3}\.){3}\d{1,3}|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;
const EXPLICIT_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
const LOOPBACK_HOST_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

function defaultSchemeForHostInput(value: string): "http" | "https" {
  return LOOPBACK_HOST_PATTERN.test(value) ? "http" : "https";
}

export function resolveWebsiteNavigationUrl(rawUrl: string): {
  url: string | null;
  error: string | null;
} {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { url: null, error: null };
  }

  if (EXPLICIT_PROTOCOL_PATTERN.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!ALLOWED_WEBSITE_PROTOCOLS.has(parsed.protocol)) {
        return { url: null, error: `Unsupported protocol: ${parsed.protocol}` };
      }

      return { url: parsed.toString(), error: null };
    } catch {
      return { url: null, error: "Invalid URL" };
    }
  }

  if (!LIKELY_HOST_PATTERN.test(trimmed)) {
    return { url: null, error: "Invalid URL" };
  }

  try {
    const parsed = new URL(
      `${defaultSchemeForHostInput(trimmed)}://${trimmed}`
    );
    return { url: parsed.toString(), error: null };
  } catch {
    return { url: null, error: "Invalid URL" };
  }
}

export function isWebsiteUrlAllowedForNavigation(rawUrl: string): boolean {
  const resolved = resolveWebsiteNavigationUrl(rawUrl);
  return resolved.url !== null && resolved.error === null;
}

export function resolveWebsiteAddressInput(rawInput: string): {
  url: string | null;
  error: string | null;
} {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return { url: null, error: null };
  }

  const navigation = resolveWebsiteNavigationUrl(trimmed);
  if (navigation.url) {
    return navigation;
  }

  const searchUrl = new URL(GOOGLE_SEARCH_BASE_URL);
  searchUrl.searchParams.set("q", trimmed);
  return { url: searchUrl.toString(), error: null };
}

export function normalizeWebsiteComparableUrl(rawUrl: string): string | null {
  const resolved = resolveWebsiteNavigationUrl(rawUrl);
  return resolved.error === null ? resolved.url : null;
}
