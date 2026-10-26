import { findRichTextMarkdownLinks } from "../core/richTextMarkdownLinks.ts";

export type RichTextReadonlyInlineSegment =
  | {
      text: string;
      type: "text";
    }
  | {
      href: string;
      label: string;
      type: "link";
    };

export function buildRichTextReadonlyInlineSegments(
  content: string
): RichTextReadonlyInlineSegment[] {
  const segments: RichTextReadonlyInlineSegment[] = [];
  let cursor = 0;

  for (const match of findRichTextMarkdownLinks(content)) {
    if (match.index > cursor) {
      segments.push({
        text: content.slice(cursor, match.index),
        type: "text"
      });
    }

    segments.push({
      href: match.href,
      label: match.label || match.href,
      type: "link"
    });
    cursor = match.to;
  }

  if (cursor < content.length) {
    segments.push({
      text: content.slice(cursor),
      type: "text"
    });
  }

  return segments;
}
