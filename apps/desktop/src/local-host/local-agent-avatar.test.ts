// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentAvatarTool } from "./local-agent-avatar";
import type { WorkspaceToolOptions } from "./local-workspace-tools";
import { SettingsOperationError } from "../shared/settings-operation-error";

const roots: string[] = [];
const signal = new AbortController().signal;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multica-agent-avatar-")); roots.push(root);
  const agent = { id: "agent", workspace_id: "workspace", avatar_url: "emoji:🐝" };
  const uploadURL = "https://storage.example/workspaces/workspace/image.png";
  const servedURL = "https://api.example/api/avatars/signature/workspaces/workspace/image.png";
  const upload = vi.fn<() => Promise<unknown>>(async () => ({ id: "image", url: uploadURL }));
  const update = vi.fn<() => Promise<unknown>>(async () => { agent.avatar_url = servedURL; return { ...agent }; });
  const read = vi.fn(async () => ({ ...agent }));
  const request = vi.fn<WorkspaceToolOptions["request"]>(async (method, path) => {
    if (method === "GET" && path === "/api/agents/foreign") return { ...agent, workspace_id: "other" };
    if (method === "GET") return read();
    if (method === "POST") return upload();
    return update();
  });
  const readFile = vi.fn(async () => ({ name: "avatar.png", mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }));
  const options = { workspaceId: "workspace", userId: "user", conversationId: "conversation", receiptsRoot: join(root, "receipts"), readFile, request };
  const input = { agent_id: "agent", file_path: join(root, "avatar.png"), request_id: "avatar-once" };
  const tool = () => createAgentAvatarTool(options);
  const call = () => tool().call(input, signal);
  return { options, input, tool, call, readFile, request, upload, update, read, agent, uploadURL, servedURL };
}

it("uploads a standalone multipart image and persists its avatar using the resolved agent ID", async () => {
  const f = await fixture(); f.input.agent_id = "agent-slug";
  expect(await f.call()).toEqual({ agent_id: "agent", workspace_id: "workspace", attachment_id: "image", avatar_url: f.servedURL, status: "updated" });
  const upload = f.request.mock.calls.find(([method]) => method === "POST")!;
  expect(upload[1]).toBe("/api/upload-file");
  const form = upload[2] as FormData;
  expect([...form.keys()]).toEqual(["file"]);
  const file = form.get("file") as File;
  expect([file.name, file.type, file.size]).toEqual(["avatar.png", "image/png", 4]);
  expect(f.request).toHaveBeenCalledWith("PUT", "/api/agents/agent", { avatar_url: f.uploadURL }, signal);
});
it("deduplicates concurrent calls and completed calls across tool recreation", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.call(), f.call()]);
  expect(second).toEqual(first); expect(await f.call()).toEqual(first);
  expect(f.upload).toHaveBeenCalledOnce(); expect(f.update).toHaveBeenCalledOnce(); expect(f.readFile).toHaveBeenCalledOnce();
  await expect(f.tool().call({ ...f.input, file_path: "/different.png" }, signal)).rejects.toThrow("different avatar input");
});
it("rejects foreign workspaces and invalid files before uploading", async () => {
  const f = await fixture();
  await expect(f.tool().call({ ...f.input, agent_id: "foreign" }, signal)).rejects.toThrow("selected workspace");
  expect(f.readFile).not.toHaveBeenCalled();
  f.readFile.mockRejectedValueOnce(new Error("Invalid image"));
  await expect(f.call()).rejects.toThrow("Invalid image");
  expect(f.upload).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
});
it("rejects malformed agent responses and does not continue after access is denied", async () => {
  const f = await fixture();
  f.read.mockResolvedValueOnce({ id: "agent", workspace_id: "workspace" } as typeof f.agent);
  await expect(f.call()).rejects.toThrow("not confirmed");
  f.read.mockRejectedValueOnce(new SettingsOperationError("http_401", "Sign in again", undefined, 401));
  await expect(f.call()).rejects.toThrow("Sign in again");
  expect(f.readFile).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
});
it("allows retrying a rejected upload without persisting an unknown outcome", async () => {
  const f = await fixture();
  f.upload.mockRejectedValueOnce(new SettingsOperationError("http_413", "Image too large", undefined, 413));
  await expect(f.call()).rejects.toThrow("Image too large");
  expect(await f.call()).toMatchObject({ status: "updated" });
  expect(f.upload).toHaveBeenCalledTimes(2); expect(f.update).toHaveBeenCalledOnce();
});
it("retains an uploaded image and safely retries a rejected update without uploading again", async () => {
  const f = await fixture();
  f.update.mockRejectedValueOnce(new SettingsOperationError("http_403", "Forbidden", undefined, 403));
  await expect(f.call()).rejects.toThrow("Forbidden");
  expect(await f.call()).toMatchObject({ status: "updated" });
  expect(f.upload).toHaveBeenCalledOnce(); expect(f.readFile).toHaveBeenCalledOnce(); expect(f.update).toHaveBeenCalledTimes(2);
});
it("reconciles a committed update when its response was lost", async () => {
  const f = await fixture();
  f.update.mockImplementationOnce(async () => { f.agent.avatar_url = f.servedURL; throw new Error("Connection lost"); });
  expect(await f.call()).toMatchObject({ avatar_url: f.servedURL, status: "updated" });
  expect(f.upload).toHaveBeenCalledOnce(); expect(f.update).toHaveBeenCalledOnce();
});
it("does not replay an ambiguous update and can confirm it on a later turn", async () => {
  const f = await fixture(); f.update.mockRejectedValueOnce(new Error("Connection lost"));
  await expect(f.call()).rejects.toThrow("not confirmed");
  await expect(f.call()).rejects.toThrow("outcome is unknown");
  expect(f.upload).toHaveBeenCalledOnce(); expect(f.update).toHaveBeenCalledOnce();
  f.agent.avatar_url = f.servedURL;
  expect(await f.call()).toMatchObject({ status: "updated" });
});
it.each(["network", "malformed"])("never repeats an upload with an unknown %s outcome", async (failure) => {
  const f = await fixture();
  if (failure === "network") f.upload.mockRejectedValueOnce(new Error("Connection lost"));
  else f.upload.mockResolvedValueOnce({ url: f.uploadURL });
  await expect(f.call()).rejects.toThrow();
  await expect(f.call()).rejects.toThrow("upload outcome is unknown");
  expect(f.upload).toHaveBeenCalledOnce(); expect(f.update).not.toHaveBeenCalled();
});
it("validates malformed update responses by reading the agent and never accepts a foreign response", async () => {
  const f = await fixture();
  f.update.mockImplementationOnce(async () => { f.agent.avatar_url = f.servedURL; return { ...f.agent, workspace_id: "foreign" }; });
  expect(await f.call()).toMatchObject({ workspace_id: "workspace", status: "updated" });
  expect(f.read).toHaveBeenCalledTimes(2);
});
it("keeps request IDs isolated between accounts and workspaces", async () => {
  const f = await fixture(); await f.call();
  f.agent.avatar_url = "emoji:🐝";
  await createAgentAvatarTool({ ...f.options, userId: "another-user" }).call(f.input, signal);
  expect(f.upload).toHaveBeenCalledTimes(2);
  await expect(createAgentAvatarTool({ ...f.options, workspaceId: "another-workspace" }).call(f.input, signal)).rejects.toThrow("selected workspace");
  expect(f.upload).toHaveBeenCalledTimes(2);
});
