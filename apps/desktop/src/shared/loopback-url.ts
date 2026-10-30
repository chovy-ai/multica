/**
 * Recognize loopback addresses without DNS so the source device owns routing.
 */
export function isLoopbackUrl(value: string): boolean {
  return previewLoopbackHost(value) !== null;
}

export function previewLoopbackHost(value: string): string | null {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
    if (host === "0.0.0.0") return "127.0.0.1";
    if (host === "::1" || /^127\./.test(host)) return host;
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped && (Number.parseInt(mapped[1]!, 16) >> 8) === 127) { const a = Number.parseInt(mapped[1]!, 16), b = Number.parseInt(mapped[2]!, 16); return `127.${a & 255}.${b >> 8}.${b & 255}`; }
    return null;
  } catch { return null; }
}
