import { chatAuthoredPrompt } from "@multica/core/chat/context-snapshot";
import type { LocalConversation } from "@multica/core/local-conversation/protocol";

const defaultTitles = new Set(["新会话", "新建会话", "New conversation", "New Conversation"]);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function plainText(value: string): string {
  return value
    .replace(/!\[(?:\\.|[^\]\\])*\]\([^)]*\)/g, " ")
    .replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\\([\\`*_{}[\]()#+.!>~-])/g, "$1")
    .replace(/(?:mention|https?):\/\/\S+/g, " ")
    .replace(/[`*~]/g, "")
    .replace(/^[\s#>-]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(value: string, limit: number): string {
  const parts = Array.from(segmenter.segment(value), ({ segment }) => segment);
  if (parts.length <= limit) return value;
  let excerpt = parts.slice(0, limit - 1).join("");
  // Preserve whole Latin words when a nearby boundary is available.
  if (/[a-zA-Z]$/.test(excerpt) && /^[a-zA-Z]/.test(parts[limit - 1] ?? "")) {
    const boundary = excerpt.lastIndexOf(" ");
    if (boundary >= excerpt.length / 2) excerpt = excerpt.slice(0, boundary);
  }
  return `${excerpt.trimEnd()}…`;
}

/** Extract the user's request and readable reference labels, never execution context. */
export function summarizeLocalConversationTitle(content: string): string {
  const labels: string[] = [];
  const authored = chatAuthoredPrompt(content).replace(/\[(@?(?:\\.|[^\]\\])*)\]\(mention:\/\/[^)\s]+\)/g, (_match, label: string) => {
    const readable = plainText(label.replace(/^@/, ""));
    if (readable && !labels.includes(readable)) labels.push(readable);
    return " ";
  });
  const firstParagraph = authored.split(/\n\s*\n/).map(plainText).find(Boolean) ?? "";
  const request = firstParagraph
    .replace(/^(?:请帮我|帮我|麻烦你|请问|能否)[，,\s]*/, "")
    .replace(/^(?:please|could you|can you|help me)\s+/i, "")
    .split(/(?<=[。！？!?])\s*/)[0]?.trim() ?? "";
  const references = labels.map((label) => shorten(label, 24)).join("、");
  return shorten(request && references ? `${shorten(request, 28)} · ${references}` : request || references || "新会话", 48);
}

export function isDefaultConversationTitle(title: string): boolean {
  return defaultTitles.has(title);
}

/** Send readable authored text, not reference URLs or injected context, to the title model. */
export function conversationTitleSource(content: string): string {
  return plainText(chatAuthoredPrompt(content).replace(/\[(@?(?:\\.|[^\]\\])*)\]\(mention:\/\/[^)\s]+\)/g, "$1")).slice(0, 8000);
}

export function normalizeModelConversationTitle(output: string): string | null {
  const title = output.trim().replace(/^#+\s*/, "").replace(/^["'“「`]+|["'”」`]+$/g, "").trim();
  if (!title || title.length > 160 || /[\r\n]|mention:\/\/|https?:\/\/|\]\(/.test(title) || isDefaultConversationTitle(title)) return null;
  return shorten(title, 48);
}

/** Upgrade old generated previews while preserving explicit names and fork lineage. */
export function refreshGeneratedConversationTitle(entry: LocalConversation): void {
  if (entry.titleMode === "manual") return;
  const first = entry.messages.find((message) => message.role === "user");
  if (!first) return;
  const suffix = entry.forkedFrom && entry.title.endsWith(" · Fork") ? " · Fork" : "";
  const previous = suffix ? entry.title.slice(0, -suffix.length) : entry.title;
  if (entry.titleMode === "auto" && !isDefaultConversationTitle(previous)) return;
  if (entry.titleMode === "auto" || isDefaultConversationTitle(previous) || previous === first.content.slice(0, 60)) {
    entry.title = `${summarizeLocalConversationTitle(first.content)}${suffix}`;
    entry.titleMode = "auto";
  }
}
