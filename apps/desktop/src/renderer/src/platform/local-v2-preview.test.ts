// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalV2Transport } from "@multica/core/local-conversation/v2";
import { LocalV2Preview } from "./local-v2-preview";

const scope = { userId: "user", workspaceId: "workspace" };
function transport(file: { mime_type: string; size: number }) {
  const request = vi.fn(async (_scope: unknown, _method: string, path: string) => path.startsWith("/preview/file?")
    ? { root: "/repo", path: "/repo/a", name: "a", ...file }
    : { entries: [{ root: "/repo", path: "/repo/b", name: "b", kind: "directory" }] });
  return { request, value: { request, send: vi.fn(), subscribe: () => () => {}, onConnection: () => () => {}, fileUrl: (_scope, path) => `v2:${path}`, upload: vi.fn(), choose: vi.fn() } as LocalV2Transport };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("LocalV2Preview", () => {
  it("loads images and PDFs by URL without reading their bytes", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const mime_type of ["image/png", "application/pdf"]) {
      const { value } = transport({ mime_type, size: 10 });
      const file = await new LocalV2Preview(value, scope).read({ root: "/repo", path: "/repo/a" }, "c1");
      expect(file).toMatchObject({ mimeType: mime_type, url: "v2:/preview/content?conversation_id=c1&root=%2Frepo&path=%2Frepo%2Fa" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads text and shows at most 1 MB", async () => {
    const limit = 1024 * 1024;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("range")).toBe(`bytes=0-${limit}`);
      return new Response(new Uint8Array(limit + 1).fill(97));
    });
    vi.stubGlobal("fetch", fetch);
    const { value } = transport({ mime_type: "text/plain", size: limit + 5 });
    const file = await new LocalV2Preview(value, scope).read({ root: "/repo", path: "/repo/a" });
    expect(file.text).toHaveLength(limit);
    expect(file.truncated).toBe(true);
  });

  it("lists a folder within the conversation's readable roots", async () => {
    const { value, request } = transport({ mime_type: "text/plain", size: 1 });
    expect(await new LocalV2Preview(value, scope).list({ root: "/repo", path: "/repo" }, "c1")).toEqual([{ root: "/repo", path: "/repo/b", name: "b", kind: "directory" }]);
    expect(request).toHaveBeenCalledWith(scope, "GET", "/preview/list?conversation_id=c1&root=%2Frepo&path=%2Frepo", undefined);
  });
});
