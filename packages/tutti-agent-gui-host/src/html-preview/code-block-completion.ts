/** Check the original Markdown, before the streaming stabilizer adds a fence. */
export function isClosedCodeBlock(source: string, node: unknown): boolean {
  const position = (node as {
    position?: { start: { offset?: number }; end: { offset?: number } };
  } | undefined)?.position;
  const start = position?.start.offset;
  const end = position?.end.offset;
  if (start === undefined || end === undefined || end > source.length) return false;
  const block = source.slice(start, end);
  const opening = /^[ \t]*(`{3,}|~{3,})[^\n]*\n/.exec(block);
  const closing = /\n(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(block);
  return !!opening && !!closing &&
    closing.index >= opening[0].length - 1 &&
    opening[1][0] === closing[1][0] && closing[1].length >= opening[1].length;
}
