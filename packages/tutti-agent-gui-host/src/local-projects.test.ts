// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAutomaticLocalDirectory } from "./local-projects";

describe("automatic local conversation directories", () => {
  const legacyScope = "a".repeat(64);
  it.each([
    `/profile/local-conversations/${legacyScope}/workdirs/conversation`,
    `C:\\profile\\local-conversations\\${legacyScope}\\workdirs\\conversation\\`,
    "/profile/local-conversations/workdirs/3/conversation",
    "/profile/local-conversations/workdirs/3/conversation/",
    "C:\\profile\\local-conversations\\workdirs\\3\\conversation",
    "C:\\profile\\local-conversations\\workdirs\\3\\conversation\\",
  ])("recognizes %s as an internal execution directory", (path) => {
    expect(isAutomaticLocalDirectory(path)).toBe(true);
  });

  it.each(["", "/projects/repository", "/projects/workdirs/3/conversation", "/profile/local-conversations/workdirs/project/repository", "/profile/local-conversations/workdirs/3/conversation/subfolder"])("preserves user directory %s", (path) => {
    expect(isAutomaticLocalDirectory(path)).toBe(false);
  });
});
