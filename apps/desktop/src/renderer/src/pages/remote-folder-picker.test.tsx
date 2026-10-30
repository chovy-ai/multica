import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { LocalV2Transport } from "@multica/core/local-conversation/v2";
import { LocalDeviceProvider, type LocalDevice } from "../platform/local-device";
import { pickRemoteFolder, RemoteFolderPicker } from "./remote-folder-picker";

const scope = { userId: "u", workspaceId: "w" };
const folders: Record<string, unknown> = {
  "": { path: "/Users/me", parent: "/Users", entries: [{ name: "repo", path: "/Users/me/repo" }] },
  "/Users/me/repo": { path: "/Users/me/repo", parent: "/Users/me", entries: [] },
};

function setup() {
  const request = vi.fn(async (_scope: unknown, _method: string, path: string) => folders[new URLSearchParams(path.split("?")[1]).get("path") ?? ""]);
  const transport = { request, send: vi.fn(), subscribe: () => () => {}, onConnection: () => () => {}, fileUrl: vi.fn(), upload: vi.fn(), choose: vi.fn() } as unknown as LocalV2Transport;
  const device = { id: "peer-1", name: "Mac Studio", transport } as unknown as LocalDevice;
  render(<QueryClientProvider client={new QueryClient()}><LocalDeviceProvider device={device}><RemoteFolderPicker chinese /></LocalDeviceProvider></QueryClientProvider>);
  return { request };
}

describe("RemoteFolderPicker", () => {
  it("browses the other device's folders and returns the chosen one", async () => {
    const { request } = setup();
    let chosen: Promise<string | null> | undefined;
    act(() => { chosen = pickRemoteFolder("peer-1", scope, { purpose: "folder_project" }); });
    expect(await screen.findByRole("dialog", { name: "选择 Mac Studio 上的文件夹" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: "repo" }));
    await waitFor(() => expect(screen.getByRole("listbox", { name: "/Users/me/repo" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "选择" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    await expect(chosen).resolves.toBe("/Users/me/repo");
    expect(request).toHaveBeenCalledWith(scope, "GET", "/directories?path=", undefined);
  });

  it("resolves null when cancelled and ignores requests for another device", async () => {
    setup();
    let other: Promise<string | null> | undefined;
    act(() => { other = pickRemoteFolder("peer-2", scope, { purpose: "folder_project" }); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    let chosen: Promise<string | null> | undefined;
    act(() => { chosen = pickRemoteFolder("peer-1", scope, { purpose: "folder_project" }); });
    await expect(other).resolves.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await expect(chosen).resolves.toBeNull();
  });
});
