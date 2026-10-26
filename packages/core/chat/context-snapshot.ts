export const CHAT_CONTEXT_SNAPSHOT_START = "\n\n<!-- multica-context-snapshot:start -->\n";
export const CHAT_CONTEXT_SNAPSHOT_END = "\n<!-- multica-context-snapshot:end -->";

/** Keep host-supplied execution context out of the authored prompt and draft. */
export function chatAuthoredPrompt(content: string): string {
  const start = content.lastIndexOf(CHAT_CONTEXT_SNAPSHOT_START);
  return start >= 0 && content.endsWith(CHAT_CONTEXT_SNAPSHOT_END)
    ? content.slice(0, start)
    : content;
}
