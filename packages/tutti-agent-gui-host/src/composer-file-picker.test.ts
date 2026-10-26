// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { pickComposerFiles } from "./composer-file-picker";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it("returns all selected files and cleans up before selecting the same file again", async () => {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  const files = [new File(["pixels"], "screenshot.png", { type: "image/png" }), new File(["notes"], "notes.txt", { type: "text/plain" })];
  for (let selection = 0; selection < 2; selection++) {
    const result = pickComposerFiles();
    const input = document.querySelector("input")!;
    expect(input.multiple).toBe(true);
    Object.defineProperty(input, "files", { value: files });
    input.dispatchEvent(new Event("change"));
    expect(await result).toEqual(files);
    expect(document.querySelector("input")).toBeNull();
  }
});

it("leaves the draft untouched when the file dialog is cancelled", async () => {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
  const result = pickComposerFiles();
  document.querySelector("input")!.dispatchEvent(new Event("cancel"));
  expect(await result).toEqual([]);
  expect(document.querySelector("input")).toBeNull();
});

it("cleans up and reports a file dialog failure", async () => {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => { throw new Error("Picker unavailable"); });
  await expect(pickComposerFiles()).rejects.toThrow("Picker unavailable");
  expect(document.querySelector("input")).toBeNull();
});
