import { Children, isValidElement, type ReactNode } from "react";
import type { MessagePreviewFormat } from "../html-preview-contract";

export function codeBlockPreview(children: ReactNode): { source: string; format: MessagePreviewFormat } | null {
  const nodes = Children.toArray(children);
  if (nodes.length !== 1 || !isValidElement<{ className?: string; children?: ReactNode }>(nodes[0])) return null;
  const { className, children: content } = nodes[0].props;
  const language = className?.split(/\s+/).map((name) => /^language-(html|htm|svg)$/i.exec(name)?.[1]?.toLowerCase()).find(Boolean);
  if (!language) return null;
  return { source: (Array.isArray(content) ? content.join("") : String(content ?? "")).replace(/\n$/, ""), format: language === "svg" ? "svg" : "html" };
}
