// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HTML_PREVIEW_INSTRUCTIONS } from "./html-preview-contract";

it("gives the daemon the same preview instructions the GUI renders", () => {
  const daemonCopy = readFileSync(join(__dirname, "../../../server/internal/localconversation/protocol/html-preview-instructions.txt"), "utf8");
  expect(daemonCopy).toBe(HTML_PREVIEW_INSTRUCTIONS);
});
