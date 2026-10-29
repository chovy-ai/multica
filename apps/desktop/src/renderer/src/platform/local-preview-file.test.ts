// @vitest-environment node
import { describe, expect, it } from "vitest";
import { blobBase64 } from "./local-preview-file";

describe("preview file bytes", () => {
  it("encodes bytes for the agent GUI frame", async () => {
    expect(await blobBase64(new Blob([new Uint8Array([104, 105])]))).toBe("aGk=");
  });
});
