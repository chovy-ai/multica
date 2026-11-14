import { isMap, isScalar, isNode, parseDocument, stringify } from "yaml";
import type { AgentMemoryEntry } from "./types";

export type MemoryDiagnosticCode =
  | "opening"
  | "closing"
  | "yaml"
  | "mapping"
  | "missing_colon"
  | "duplicate"
  | "required"
  | "title"
  | "description"
  | "system"
  | "body"
  | "hard_limit"
  | "soft_limit";
export interface MemoryDiagnostic {
  start: number;
  end: number;
  severity: "error" | "warning";
  code: MemoryDiagnosticCode;
  field?: string;
  detail?: string;
}

export function formatMemoryDocument(entry: AgentMemoryEntry): string {
  return (
    entry.document ??
    `---\n${stringify({
      title: entry.title,
      description: entry.description,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      source: entry.source,
    })}---\n${entry.body ?? ""}`
  );
}

export function parseMemoryDocument(text: string, original: AgentMemoryEntry) {
  const diagnostics: MemoryDiagnostic[] = [];
  let title = "",
    description = "",
    body = "";
  const add = (
    code: MemoryDiagnosticCode,
    start: number,
    end = start + 1,
    field?: string,
    detail?: string,
    severity: MemoryDiagnostic["severity"] = "error",
  ) => {
    diagnostics.push({
      code,
      start,
      end: Math.max(start + 1, end),
      field,
      detail,
      severity,
    });
  };
  const result = () => ({
    title,
    description,
    body,
    bytes: new TextEncoder().encode(body).length,
    diagnostics,
  });
  if (!text.startsWith("---\n")) {
    add("opening", 0, Math.max(1, text.indexOf("\n")));
    return result();
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    add("closing", 0, 3);
    return result();
  }
  body = text.slice(end + 5);
  const doc = parseDocument(text.slice(4, end), {
    uniqueKeys: true,
    prettyErrors: false,
  });
  for (const error of doc.errors) {
    const start = error.pos[0] + 4;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", start);
    const missing =
      /^\s*(title|description|created_at|updated_at|source)\s+[^:]/.exec(
        text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd),
      );
    if (error.code === "DUPLICATE_KEY")
      add("duplicate", start, error.pos[1] + 4);
    else if (missing)
      add(
        "missing_colon",
        start,
        lineEnd < 0 ? text.length : lineEnd,
        missing[1],
      );
    else add("yaml", start, error.pos[1] + 4, undefined, error.message);
  }
  if (diagnostics.length) return result();
  if (
    !isMap(doc.contents) ||
    doc.contents.items.some(
      (pair) => !isScalar(pair.key) || typeof pair.key.value !== "string",
    )
  ) {
    add("mapping", 4, end);
    return result();
  }
  for (const [key, max] of [
    ["title", 100],
    ["description", 200],
  ] as const) {
    const candidate = doc.get(key, true);
    const node = isNode(candidate) ? candidate : undefined;
    const start = node?.range?.[0] === undefined ? 0 : node.range[0] + 4;
    const stop = node?.range?.[1] === undefined ? 3 : node.range[1] + 4;
    const value = isScalar(node) ? node.value : undefined;
    if (typeof value !== "string" || !value.trim())
      add("required", start, stop, key);
    else {
      if (key === "title") title = value.trim();
      else description = value.trim();
      if (/[\r\n]/.test(value) || [...value.trim()].length > max)
        add(key, start, stop);
    }
  }
  for (const [field, expected] of [
    ["created_at", original.createdAt],
    ["updated_at", original.updatedAt],
    ["source", original.source],
  ] as const) {
    const candidate = doc.get(field, true);
    const node = isNode(candidate) ? candidate : undefined;
    const value = isScalar(node) ? node.value : undefined;
    const same =
      field === "source"
        ? value === expected
        : typeof value === "string" &&
          Number.isFinite(Date.parse(value)) &&
          Date.parse(value) === Date.parse(expected);
    if (!same)
      add(
        "system",
        (node?.range?.[0] ?? 0) + 4,
        (node?.range?.[1] ?? 1) + 4,
        field,
      );
  }
  const bytes = new TextEncoder().encode(body).length;
  if (!body.trim()) add("body", end + 5);
  else if (bytes > 8192)
    add(
      "hard_limit",
      end + 5,
      text.indexOf("\n", end + 5) < 0
        ? text.length
        : text.indexOf("\n", end + 5),
    );
  else if (bytes > 2048)
    add("soft_limit", end + 5, end + 6, undefined, undefined, "warning");
  return result();
}
