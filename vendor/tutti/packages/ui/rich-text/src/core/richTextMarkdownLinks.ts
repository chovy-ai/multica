export interface RichTextMarkdownLinkMatch {
  href: string;
  index: number;
  label: string;
  source: string;
  to: number;
}

export function* findRichTextMarkdownLinks(
  value: string
): Generator<RichTextMarkdownLinkMatch> {
  let cursor = 0;

  while (cursor < value.length) {
    const labelStart = value.indexOf("[", cursor);
    if (labelStart < 0) {
      return;
    }
    if (labelStart > 0 && value[labelStart - 1] === "!") {
      cursor = labelStart + 1;
      continue;
    }

    const labelEnd = findMarkdownLabelEnd(value, labelStart + 1);
    if (labelEnd < 0 || value[labelEnd + 1] !== "(") {
      cursor = labelStart + 1;
      continue;
    }

    const hrefStart = labelEnd + 2;
    const hrefEnd = findMarkdownHrefEnd(value, hrefStart);
    if (hrefEnd < 0) {
      cursor = labelStart + 1;
      continue;
    }

    yield {
      href: unescapeMarkdownLinkText(value.slice(hrefStart, hrefEnd)),
      index: labelStart,
      label: unescapeMarkdownLinkText(value.slice(labelStart + 1, labelEnd)),
      source: value.slice(labelStart, hrefEnd + 1),
      to: hrefEnd + 1
    };
    cursor = hrefEnd + 1;
  }
}

function unescapeMarkdownLinkText(value: string): string {
  return value.replace(/\\([\\[\]()])/g, "$1");
}

function findMarkdownLabelEnd(value: string, cursor: number): number {
  let escaped = false;

  for (let index = cursor; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "]") {
      return index;
    }
  }

  return -1;
}

function findMarkdownHrefEnd(value: string, cursor: number): number {
  let escaped = false;
  let depth = 0;

  for (let index = cursor; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }

  return -1;
}
