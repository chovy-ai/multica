import assert from "node:assert/strict";
import test from "node:test";
import { buildRichTextReadonlyInlineSegments } from "./richTextReadonlyContentModel.ts";

test("readonly inline model parses links with spaces and parentheses in hrefs", () => {
  const content =
    "[download_1769497089987.jpg](/Users/example/Downloads/download_1769497089987.jpg) [White House (cropped).jpg](/Users/example/Downloads/White House (cropped).jpg) [White House (cropped).txt](/Users/example/Downloads/White House (cropped).txt)";

  assert.deepEqual(buildRichTextReadonlyInlineSegments(content), [
    {
      href: "/Users/example/Downloads/download_1769497089987.jpg",
      label: "download_1769497089987.jpg",
      type: "link"
    },
    {
      text: " ",
      type: "text"
    },
    {
      href: "/Users/example/Downloads/White House (cropped).jpg",
      label: "White House (cropped).jpg",
      type: "link"
    },
    {
      text: " ",
      type: "text"
    },
    {
      href: "/Users/example/Downloads/White House (cropped).txt",
      label: "White House (cropped).txt",
      type: "link"
    }
  ]);
});
