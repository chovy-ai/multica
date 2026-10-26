import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRichTextTextareaDecorationSegments,
  hasRichTextTextareaDecorations,
  resolveRichTextTextareaSelectionBoundary
} from "./richTextTextareaDecorationModel.ts";

test("buildRichTextTextareaDecorationSegments decorates workspace-style markdown links", () => {
  const segments = buildRichTextTextareaDecorationSegments(
    "hello [SKILL.md](~/.agents/skills/lark-shared/SKILL.md)"
  );

  assert.equal(hasRichTextTextareaDecorations(segments), true);
  assert.deepEqual(segments, [
    { type: "text", text: "hello ", from: 0, to: 6 },
    {
      type: "link",
      text: "[SKILL.md](~/.agents/skills/lark-shared/SKILL.md)",
      from: 6,
      to: 55,
      label: "SKILL.md",
      href: "~/.agents/skills/lark-shared/SKILL.md",
      kind: "file"
    }
  ]);
});

test("buildRichTextTextareaDecorationSegments preserves full token ranges", () => {
  const value = "[docs](~/docs/readme.md)";
  const segments = buildRichTextTextareaDecorationSegments(value);

  assert.deepEqual(segments, [
    {
      type: "link",
      text: value,
      from: 0,
      to: value.length,
      label: "docs",
      href: "~/docs/readme.md",
      kind: "file"
    }
  ]);
});

test("resolveRichTextTextareaSelectionBoundary snaps collapsed cursor outside a link token", () => {
  const value = "a [docs](~/docs/readme.md) z";
  const segments = buildRichTextTextareaDecorationSegments(value);

  assert.equal(resolveRichTextTextareaSelectionBoundary(segments, 6), 2);
  assert.equal(resolveRichTextTextareaSelectionBoundary(segments, 18), 26);
  assert.equal(resolveRichTextTextareaSelectionBoundary(segments, 1), null);
});
