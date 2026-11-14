// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatMemoryDocument, parseMemoryDocument } from "./memory-document";
import type { AgentMemoryEntry } from "./types";
const entry: AgentMemoryEntry = {
  path: "feedback/test.md",
  kind: "feedback",
  projectDir: "",
  title: "先找根因",
  description: "Verify the cause",
  source: "CHOV-117",
  createdAt: "2026-11-14T09:00:00Z",
  updatedAt: "2026-11-14T09:00:00Z",
  body: "## Why\n\nEvidence",
};
const source = formatMemoryDocument(entry);
describe("memory document diagnostics", () => {
  it("accepts canonical documents and leaves Markdown syntax permissive", () => {
    expect(
      parseMemoryDocument(source + "\n[unfinished Markdown", entry).diagnostics,
    ).toEqual([]);
    expect(parseMemoryDocument(source, entry)).toMatchObject({
      title: entry.title,
      description: entry.description,
      body: entry.body,
    });
  });
  it("locates missing-colon and duplicate-key errors in the source", () => {
    const bad = source.replace("description:", "description");
    const [issue] = parseMemoryDocument(bad, entry).diagnostics;
    expect(issue).toMatchObject({
      code: "missing_colon",
      severity: "error",
      start: bad.indexOf("description"),
    });
    expect(
      parseMemoryDocument(
        source.replace("title:", "title: First\ntitle:"),
        entry,
      ).diagnostics[0]?.code,
    ).toBe("duplicate");
  });
  it.each([
    ["opening", source.slice(4)],
    ["closing", source.replace("\n---\n##", "\n##")],
    ["required", formatMemoryDocument({ ...entry, title: "" })],
    ["title", formatMemoryDocument({ ...entry, title: "中".repeat(101) })],
    ["title", formatMemoryDocument({ ...entry, title: "line\nbreak" })],
    [
      "description",
      formatMemoryDocument({ ...entry, description: "x".repeat(201) }),
    ],
    ["body", formatMemoryDocument({ ...entry, body: "  " })],
    ["hard_limit", formatMemoryDocument({ ...entry, body: "界".repeat(2731) })],
    ["system", source.replace("CHOV-117", "CHOV-118")],
    ["system", source.replace("created_at:", "other_time:")],
  ])("reports %s", (code, text) => {
    expect(
      parseMemoryDocument(text, entry).diagnostics.map((d) => d.code),
    ).toContain(code);
  });
  it("counts Unicode characters and UTF-8 body bytes independently", () => {
    const parsed = parseMemoryDocument(
      formatMemoryDocument({
        ...entry,
        title: "中".repeat(100),
        body: "界".repeat(700),
      }),
      entry,
    );
    expect(parsed.bytes).toBe(2100);
    expect(parsed.diagnostics).toMatchObject([
      { code: "soft_limit", severity: "warning" },
    ]);
  });
  it("keeps unknown fields editable without expanding YAML aliases", () => {
    const document = source.replace(
      "\n---\n##",
      "\ncustom: &example [one, two]\nrelated: *example\n---\n##",
    );
    expect(parseMemoryDocument(document, entry).diagnostics).toEqual([]);
    expect(formatMemoryDocument({ ...entry, document })).toBe(document);
  });
});
