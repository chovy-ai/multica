import { describe, expect, it, vi } from "vitest";
import { blobBase64, hydratePreviewFile } from "./local-preview-file";

const scope = { userId: "user", workspaceId: "ws" };
const base = { name: "file", path: "/p/file", size: 0, truncated: false };

function client(bytes: Uint8Array<ArrayBuffer>) {
  return { files: { upload: vi.fn(), url: vi.fn((_scope, ref: string) => `multica-local-file://local/files/${ref}`), read: vi.fn(async () => new Blob([bytes])) } };
}

describe("preview file hydration", () => {
  it("loads images and PDFs by URL without reading their bytes", async () => {
    const c = client(new Uint8Array());
    for (const mimeType of ["image/png", "application/pdf"]) {
      expect(await hydratePreviewFile(c, scope, { ...base, mimeType, fileRef: "ref" })).toMatchObject({ url: "multica-local-file://local/files/ref" });
    }
    expect(c.files.read).not.toHaveBeenCalled();
  });

  it("reads text and shows at most 1 MB", async () => {
    const c = client(new TextEncoder().encode("x".repeat(1024 * 1024 + 1)));
    const file = await hydratePreviewFile(c, scope, { ...base, mimeType: "text/plain", fileRef: "ref" });
    expect(file.text).toHaveLength(1024 * 1024);
    expect(file.truncated).toBe(true);
  });

  it("encodes bytes for the agent GUI frame", async () => {
    expect(await blobBase64(new Blob([new Uint8Array([104, 105])]))).toBe("aGk=");
  });
});
