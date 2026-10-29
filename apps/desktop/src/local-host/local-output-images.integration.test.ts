// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalConversationService } from "./local-conversation-service";
import { ProviderStream, type runLocalProvider } from "./local-provider-runner";
import * as outputImages from "./local-output-images";

const roots: string[] = [], stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = { userId: "image-user", workspaceId: "image-workspace" };
const png = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNQzjxBEmIY1TCqYfhqAAAciFQQmuMXLwAAAABJRU5ErkJggg==";
it("publishes completed Codex images even when a running-history read was already scanning", async () => {
  const root = await mkdtemp(join(tmpdir(), "multica-live-image-")); roots.push(root);
  const native = "11111111-1111-4111-8111-111111111111", codexHome = join(root, "codex"); vi.stubEnv("CODEX_HOME", codexHome);
  let finishRun!: () => void, finishScan!: () => void;
  const runGate = new Promise<void>((resolve) => { finishRun = resolve; });
  const scanGate = new Promise<void>((resolve) => { finishScan = resolve; });
  const discovery = vi.spyOn(outputImages, "discoverCodexOutputImages").mockImplementationOnce(async () => { await scanGate; return []; });
  const run = vi.fn<typeof runLocalProvider>(async (input) => {
    input.onSessionId?.(native);
    const folder = join(codexHome, "generated_images", native); await mkdir(folder, { recursive: true }); await writeFile(join(folder, "live.png"), Buffer.from(png, "base64"));
    await runGate;
    return { output: "Image ready", sessionId: native };
  });
  const options = { root: join(root, "store"), apiUrl: "https://example.test", notify: vi.fn(), chooseDirectory: async () => null, find: async () => "/test-owned/unused-cli", run };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId);
  stops.push(async () => { finishRun(); finishScan(); await service.stop(); });
  const entry = await service.request(scope, "create", { provider: "codex" });
  await service.request(scope, "send", { id: entry.id, content: "Draw fixture" });
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  const refresh = service.request(scope, "read", { id: entry.id });
  await vi.waitFor(() => expect(discovery).toHaveBeenCalledTimes(1));
  finishRun();
  await vi.waitFor(async () => expect((await service.request(scope, "list", {}))[0]!.turns).toHaveLength(0));
  finishScan(); await refresh; await service.stop();
  const [folder] = await readdir(options.root);
  const index = JSON.parse(await readFile(join(options.root, folder!, "index.json"), "utf8"));
  const saved = JSON.parse(await readFile(join(options.root, folder!, "details", index.sessions[0].file), "utf8"));
  expect(saved.turns[0].events.filter((event: { tool?: string }) => event.tool === "ImageGeneration")).toHaveLength(1);
  expect(options.notify).toHaveBeenCalledWith(scope, entry.id);
});
it.each(["codex", "claude"] as const)("persists %s output images, restores history and forks without exposing arbitrary local files", async (provider) => {
  const root = await mkdtemp(join(tmpdir(), "multica-output-image-service-")); roots.push(root);
  const native = "11111111-1111-4111-8111-111111111111", codexHome = join(root, "codex"); vi.stubEnv("CODEX_HOME", codexHome);
  const run = vi.fn<typeof runLocalProvider>(async (_input, emit) => {
    if (provider === "codex") {
      const folder = join(codexHome, "generated_images", native); await mkdir(folder, { recursive: true }); await writeFile(join(folder, "generated.png"), Buffer.from(png, "base64"));
    } else new ProviderStream("claude", emit).accept(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fixture-image", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] } }));
    return { output: "Image ready", sessionId: native };
  });
  const options = { root: join(root, "store"), apiUrl: "https://example.test", notify: vi.fn(), chooseDirectory: async () => null, find: async () => "/test-owned/unused-cli", run, fork: async () => "22222222-2222-4222-8222-222222222222" };
  const service = new LocalConversationService(options); service.setCurrentUser(scope.userId); stops.push(() => service.stop());
  const entry = await service.request(scope, "create", { provider });
  await service.request(scope, "send", { id: entry.id, content: "Draw a fixture" });
  await vi.waitFor(async () => expect((await service.request(scope, "read", { id: entry.id })).turns[0]?.events.filter((event) => event.tool === "ImageGeneration")).toHaveLength(1));
  const completed = await service.request(scope, "read", { id: entry.id });
  const imageEvent = completed.turns[0]!.events.find((event) => event.tool === "ImageGeneration")!;
  const path = JSON.parse(imageEvent.output!).savedPath;
  expect(path).toMatch(/^\/multica-local-images\//); expect(imageEvent.output).not.toContain(png);
  // Image bytes are streamed by the host through a short-lived grant.
  const granted = async (owner: LocalConversationService, id: string) => {
    const image = await owner.request(scope, "imageRead", { id, path });
    return { ...image, bytes: (await readFile((await owner.resolveFile(scope, image.fileRef!)).path)).toString("base64") };
  };
  expect(await granted(service, entry.id)).toMatchObject({ bytes: png, mimeType: "image/png" });
  const unrelated = await service.request(scope, "create", { provider });
  await expect(service.request(scope, "imageRead", { id: unrelated.id, path })).rejects.toThrow("does not belong");
  await writeFile(join(root, "secret.png"), Buffer.from(png, "base64"));
  await expect(service.request(scope, "imageRead", { id: entry.id, path: join(root, "secret.png") })).rejects.toThrow("outside");
  const branch = await service.request(scope, "fork", { id: entry.id });
  expect(await granted(service, branch.id)).toMatchObject({ bytes: png });
  await service.stop(); await rm(codexHome, { recursive: true, force: true });
  const restarted = new LocalConversationService(options); restarted.setCurrentUser(scope.userId); stops.push(() => restarted.stop());
  const restored = await restarted.request(scope, "read", { id: entry.id });
  expect(restored.turns[0]!.events.filter((event) => event.tool === "ImageGeneration")).toHaveLength(1);
  expect(await granted(restarted, entry.id)).toMatchObject({ bytes: png });
  const folders = await readdir(options.root);
  const index = JSON.parse(await readFile(join(options.root, folders[0]!, "index.json"), "utf8"));
  const details = await Promise.all(index.sessions.map((item: { file: string }) => readFile(join(options.root, folders[0]!, "details", item.file), "utf8")));
  expect(details.join("\n")).not.toContain(png);
  expect(run.mock.calls[0]![0].systemPrompt).toContain("Markdown image syntax");
});
