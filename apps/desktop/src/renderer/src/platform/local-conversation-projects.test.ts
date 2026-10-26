// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LocalConversation, LocalFolderProject } from "@multica/tutti-agent-gui-host/local-protocol";
import { groupLocalConversations, projectForDirectory } from "./local-conversation-projects";

const projects = [{ id: "a", title: "Shared title", path: "/repo-a" }, { id: "b", title: "Shared title", path: "/repo-b" }] as LocalFolderProject[];
const session = (id: string, cwd = "/unregistered", archived = false) => ({ id, title: id, cwd, archived, messages: [] }) as unknown as LocalConversation;
describe("local conversation folder grouping", () => {
  it("groups by working directory, preserves session ordering, and puts unregistered directories last", () => {
    const groups = groupLocalConversations([session("b-pinned", "/repo-b"), session("legacy"), session("a", "/repo-a"), session("b-recent", "/repo-b/"), session("cleared"), session("archived", "/repo-a", true)], projects, false, "");
    expect(groups.map((group) => [group.id, group.sessions.map((entry) => entry.id)])).toEqual([["a", ["a"]], ["b", ["b-pinned", "b-recent"]], [null, ["legacy", "cleared"]]]);
  });
  it("ignores cloud task project IDs without changing stored task associations or working directories", () => {
    const linked = { ...session("linked", "/repo-b"), projectId: "a" };
    const original = structuredClone(linked);
    const groups = groupLocalConversations([linked], projects, false, "");
    expect(groups.find((group) => group.id === "b")?.sessions).toEqual([linked]);
    expect(groups.find((group) => group.id === "a")?.sessions).toEqual([]);
    expect(linked).toEqual(original);
    expect(projectForDirectory(projects, "/repo-b/")?.id).toBe("b");
  });
  it("keeps empty workspace projects available after loading while archives only show projects with archived sessions", () => {
    expect(groupLocalConversations([], projects, false, "").map((group) => [group.id, group.sessions.length])).toEqual([["a", 0], ["b", 0], [null, 0]]);
    expect(groupLocalConversations([], projects, true, "")).toEqual([]);
  });
  it("searches project names while preserving archive filtering and hiding empty search groups", () => {
    const rows = [session("active", "/repo-a"), session("archived", "/repo-a", true), session("other")];
    expect(groupLocalConversations(rows, projects, false, "shared").map((group) => group.sessions.map((entry) => entry.id))).toEqual([["active"]]);
    expect(groupLocalConversations(rows, projects, true, "shared")[0]?.sessions[0]?.id).toBe("archived");
    expect(groupLocalConversations(rows, projects, false, "missing")).toEqual([]);
    expect(groupLocalConversations(rows, projects, false, "/repo-a")[0]?.sessions[0]?.id).toBe("active");
  });
});
