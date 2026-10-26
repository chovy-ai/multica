// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { LocalConversation, LocalPreviewFile, LocalPreviewLocation } from "@multica/tutti-agent-gui-host/local-protocol";
import { FileLinkPreviewError, fileLinkErrorMessage, resolveConversationFile } from "./local-resource-resolution";

function fixture(contents = "See `output/batch/walkthrough.md`.") {
  const files = new Map<string, LocalPreviewFile>();
  const folders: LocalPreviewLocation[] = ["project", "other"].map((name) => ({ root: "/workspace", path: `/workspace/${name}`, name, kind: "directory" }));
  const source: Pick<LocalConversation, "cwd" | "messages"> = { cwd: "/workspace", messages: [{ id: "reply", role: "assistant", content: contents, turnId: "turn", createdAt: "2026-10-25" }] };
  const read = vi.fn(async (path: string) => { const file = files.get(path); if (!file) throw new Error(`Error invoking remote method 'local-conversation:request': Error: ENOENT: no such file, realpath '${path}'`); return file; });
  const list = vi.fn(async () => folders);
  const add = (path: string) => files.set(path, { path, name: path.split("/").at(-1)!, text: "Verified report", size: 15, truncated: false, mimeType: "text/plain" });
  const open = (value = "walkthrough.md") => resolveConversationFile({ source, value, read, list });
  return { source, files, folders, read, list, add, open };
}

it("opens an exact working-directory file before considering references", async () => {
  const f = fixture(); f.add("/workspace/walkthrough.md"); f.add("/workspace/project/output/batch/walkthrough.md");
  expect((await f.open()).file.path).toBe("/workspace/walkthrough.md");
  expect(f.list).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(1);
});
it.each(["`output/batch/walkthrough.md`", "[Report](output/batch/walkthrough.md)", "[Report](<output/batch/walkthrough.md>)"])("recovers a filename from an explicit conversation reference: %s", async (reference) => {
  const f = fixture(reference); f.add("/workspace/project/output/batch/walkthrough.md");
  expect(await f.open("./walkthrough.md:12")).toMatchObject({ file: { path: "/workspace/project/output/batch/walkthrough.md" }, line: 12 });
  expect(f.list).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(f.read.mock.calls.every(([path]) => path.startsWith("/workspace/"))).toBe(true);
});
it("uses the cited path directly when the conversation already runs in the project", async () => {
  const f = fixture(); f.add("/workspace/output/batch/walkthrough.md");
  expect((await f.open()).file.path).toBe("/workspace/output/batch/walkthrough.md");
  expect(f.list).not.toHaveBeenCalled();
});
it("does not guess between two projects containing the same cited file", async () => {
  const f = fixture(); for (const project of ["project", "other"]) f.add(`/workspace/${project}/output/batch/walkthrough.md`);
  await expect(f.open()).rejects.toMatchObject({ kind: "ambiguous" });
});
it("does not use a newer location when another cited location may have been deleted", async () => {
  const f = fixture("Old: `first/walkthrough.md`. New: `second/walkthrough.md`.");
  f.add("/workspace/second/walkthrough.md");
  await expect(f.open()).rejects.toMatchObject({ kind: "ambiguous" });
});
it("does not infer uniqueness from a truncated conversation history", async () => {
  const f = fixture("x".repeat(2_000_001));
  await expect(f.open()).rejects.toMatchObject({ kind: "incomplete" }); expect(f.list).not.toHaveBeenCalled();
});
it.each(["/missing/walkthrough.md", "../walkthrough.md"])("keeps a missing explicit location strict: %s", async (value) => {
  const f = fixture(); f.add("/workspace/project/output/batch/walkthrough.md");
  await expect(f.open(value)).rejects.toMatchObject({ kind: "missing" });
  expect(f.list).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(1);
});
it("does not search when a short name has no supporting path reference", async () => {
  const f = fixture("The file is called `walkthrough.md`. `$B/walkthrough.md` is a shell variable.");
  await expect(f.open()).rejects.toMatchObject({ kind: "missing" }); expect(f.list).not.toHaveBeenCalled();
});
it("retains access-denied boundaries and does not turn them into lookup attempts", async () => {
  const f = fixture(); f.read.mockRejectedValue(new Error("The file is outside the selected folder"));
  await expect(f.open()).rejects.toMatchObject({ kind: "denied" }); expect(f.list).not.toHaveBeenCalled();
});
it("stops instead of accepting a truncated project listing", async () => {
  const f = fixture(); f.folders.push(...Array.from({ length: 1000 }, (_, index) => ({ root: "/workspace", path: `/workspace/${index}`, name: `${index}`, kind: "file" as const })));
  await expect(f.open()).rejects.toMatchObject({ kind: "incomplete" });
});
it("bounds lookups when a workspace contains excessive projects", async () => {
  const f = fixture();
  f.folders.push(...Array.from({ length: 600 }, (_, index) => ({ root: "/workspace", path: `/workspace/p${index}`, name: `p${index}`, kind: "directory" as const })));
  await expect(f.open()).rejects.toMatchObject({ kind: "incomplete" });
});
it("does not conceal unexpected filesystem failures", async () => {
  const f = fixture(); f.read.mockRejectedValue(new Error("Disk I/O failure"));
  await expect(f.open()).rejects.toThrow("Disk I/O failure");
});
it("provides actionable localized errors without exposing the IPC wrapper", () => {
  for (const kind of ["missing", "ambiguous", "denied", "incomplete"] as const) {
    expect(fileLinkErrorMessage(new FileLinkPreviewError(kind), true)).toContain("文件");
    expect(fileLinkErrorMessage(new FileLinkPreviewError(kind), false)).not.toMatch(/ENOENT|remote method|realpath/);
  }
});
