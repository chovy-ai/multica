const allowedBrowserProtocols = new Set(["http:", "https:"]);
const likelyHostPattern =
  /^(localhost|(\d{1,3}\.){3}\d{1,3}|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;
const explicitProtocolPattern = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
const loopbackHostPattern =
  /^(localhost|127(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

function defaultSchemeForHostInput(value: string): "http" | "https" {
  return loopbackHostPattern.test(value) ? "http" : "https";
}

export type BrowserNavigationUrlErrorCode =
  | "invalid-url"
  | "unsupported-protocol";

export interface BrowserNavigationUrlResolution {
  errorCode: BrowserNavigationUrlErrorCode | null;
  errorParams?: Record<string, string>;
  url: string | null;
}

export type BrowserSearchUrlResolver = (query: string) => string | null;

export function resolveBrowserNavigationUrl(
  rawUrl: string
): BrowserNavigationUrlResolution {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { errorCode: null, url: null };
  }

  if (explicitProtocolPattern.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!allowedBrowserProtocols.has(parsed.protocol)) {
        return {
          errorCode: "unsupported-protocol",
          errorParams: { protocol: parsed.protocol },
          url: null
        };
      }

      return { errorCode: null, url: parsed.toString() };
    } catch {
      return { errorCode: "invalid-url", url: null };
    }
  }

  if (!likelyHostPattern.test(trimmed)) {
    return { errorCode: "invalid-url", url: null };
  }

  try {
    const parsed = new URL(
      `${defaultSchemeForHostInput(trimmed)}://${trimmed}`
    );
    return { errorCode: null, url: parsed.toString() };
  } catch {
    return { errorCode: "invalid-url", url: null };
  }
}

export type BrowserAddressInputResolution = BrowserNavigationUrlResolution;

export function resolveBrowserAddressInput(
  rawInput: string,
  options: {
    resolveSearchUrl?: BrowserSearchUrlResolver;
  } = {}
): BrowserAddressInputResolution {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return { errorCode: null, url: null };
  }

  const navigation = resolveBrowserNavigationUrl(trimmed);
  if (navigation.url) {
    return navigation;
  }

  const searchUrl = options.resolveSearchUrl?.(trimmed);
  if (!searchUrl) {
    return navigation;
  }

  return resolveBrowserNavigationUrl(searchUrl);
}

export function normalizeBrowserComparableUrl(rawUrl: string): string | null {
  const resolved = resolveBrowserNavigationUrl(rawUrl);
  return resolved.errorCode === null ? resolved.url : null;
}

export function resolveBrowserOpenExternalUrl(
  rawUrl: string
): BrowserNavigationUrlResolution {
  return resolveHostBrowserNavigationUrl(rawUrl);
}

export function resolveHostBrowserNavigationUrl(
  rawUrl: string
): BrowserNavigationUrlResolution {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { errorCode: null, url: null };
  }

  if (trimmed.startsWith("file://")) {
    try {
      return { errorCode: null, url: new URL(trimmed).toString() };
    } catch {
      return { errorCode: "invalid-url", url: null };
    }
  }

  return resolveBrowserNavigationUrl(trimmed);
}

export function normalizeHostBrowserComparableUrl(
  rawUrl: string
): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }

  return normalizeBrowserComparableUrl(trimmed);
}
