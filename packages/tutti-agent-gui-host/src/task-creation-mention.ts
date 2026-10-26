import { CREATE_TASK_MENTION_ID } from "./local-protocol";
import { parseRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
export { CREATE_TASK_MENTION_ID };

export function isTaskCreationMention(item: { kind?: string; targetId?: string }): boolean {
  return item.kind === "workspace-issue" && item.targetId === CREATE_TASK_MENTION_ID;
}

export function isTaskCreationMentionHref(href: string): boolean {
  const mention = parseRichTextMentionHref(href);
  return mention?.providerId === "workspace-issue" && mention.entityId === CREATE_TASK_MENTION_ID;
}
