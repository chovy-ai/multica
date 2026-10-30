/**
 * Whether a webpage address points at the machine that opens it. Another
 * device's localhost is not this one's, so its pages show a notice instead.
 */
export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  } catch { return false; }
}
