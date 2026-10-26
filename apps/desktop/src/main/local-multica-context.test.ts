// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMulticaContext } from "./local-multica-context";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = { userId: "user", workspaceId: "workspace" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multica-query-context-")); roots.push(root);
  const cliPath = join(root, "fake multica"); await writeFile(cliPath, "fake", { mode: 0o700 });
  const readProfile = vi.fn(async () => ({ userId: "user", token: "mul_test_credential", serverUrl: "https://example.test" }));
  const verifyAccount = vi.fn(async () => "user");
  const options = { root: join(root, "contexts"), cliPath, apiUrl: "https://example.test", readProfile, verifyAccount };
  return { options, context: new LocalMulticaContext(options) };
}

describe("local Multica query context", () => {
  it("keeps queue credentials in the main process and pins requests to the verified account and workspace", async () => {
    const { context } = await fixture();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "result" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const request = await context.queueClient(scope, signal);
    await request("POST", "/api/chat/sessions", { agent_id: "agent" });
    expect(fetcher).toHaveBeenCalledWith("https://example.test/api/chat/sessions", expect.objectContaining({
      headers: { Authorization: "Bearer mul_test_credential", "X-Workspace-ID": "workspace", "Content-Type": "application/json" }, redirect: "error",
    }));
    await expect(request("GET", "https://other.test/api/me")).rejects.toThrow("Invalid Multica API path");
    await expect(context.queueClient({ ...scope, userId: "other" }, signal)).rejects.toThrow("Cloud Multica login is unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("pins verified desktop credentials to a private per-run config without putting secrets in the prompt or environment", async () => {
    vi.stubEnv("MULTICA_TOKEN", "wrong-parent-token"); vi.stubEnv("MULTICA_TASK_ID", "wrong-task"); vi.stubEnv("MULTICA_AGENT_ID", "wrong-agent"); vi.stubEnv("MULTICA_DAEMON_PORT", "1234"); vi.stubEnv("ANTHROPIC_BASE_URL", "https://user-model-service.test");
    const { options, context } = await fixture();
    const prepared = await context.prepare(scope, new AbortController().signal);
    expect(options.readProfile).toHaveBeenCalledWith("desktop-example.test");
    expect(options.verifyAccount).toHaveBeenCalledWith("mul_test_credential", expect.any(AbortSignal));
    const directory = prepared.env.MULTICA_TASK_CONFIG_ROOT!;
    expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8"))).toEqual({ token: "mul_test_credential", server_url: "https://example.test", workspace_id: "workspace" });
    expect(prepared.env).toMatchObject({ MULTICA_SERVER_URL: "https://example.test", MULTICA_WORKSPACE_ID: "workspace", ANTHROPIC_BASE_URL: "https://user-model-service.test" });
    for (const key of ["MULTICA_TOKEN", "MULTICA_AGENT_ID", "MULTICA_TASK_ID", "MULTICA_DAEMON_PORT"]) expect(prepared.env[key]).toBeUndefined();
    expect(prepared.systemPrompt).toContain("issue context <issue-key-or-uuid>");
    expect(prepared.systemPrompt).toContain("attachment download");
    expect(prepared.systemPrompt).toContain("comments_page.has_more");
    expect(prepared.systemPrompt).toContain("--workspace-id 'workspace'");
    expect(prepared.systemPrompt).toContain("id=<copied-conversation-id>, source=local");
    expect(prepared.systemPrompt).not.toContain("mul_test_credential"); expect(prepared.systemPrompt).not.toContain("wrong-parent-token");
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "config.json"))).mode & 0o777).toBe(0o600);
    }
    await prepared.dispose(); await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["account", "server", "token-owner", "offline"])("fails closed for %s without falling back to global CLI credentials", async (failure) => {
    const { options } = await fixture();
    if (failure === "account") options.readProfile.mockResolvedValue({ userId: "other", token: "mul_wrong", serverUrl: options.apiUrl });
    if (failure === "server") options.readProfile.mockResolvedValue({ userId: "user", token: "mul_wrong", serverUrl: "https://other.test" });
    if (failure === "token-owner") options.verifyAccount.mockResolvedValue("other");
    if (failure === "offline") options.verifyAccount.mockRejectedValue(new Error("offline"));
    const prepared = await new LocalMulticaContext(options).prepare(scope, new AbortController().signal);
    expect(prepared.systemPrompt).toContain("queries are currently unavailable");
    expect(prepared.systemPrompt).toContain("Local MCP conversation, message, execution and attachment queries remain available");
    expect(JSON.parse(await readFile(join(prepared.env.MULTICA_TASK_CONFIG_ROOT!, "config.json"), "utf8")).token).toBe("");
    if (failure === "account" || failure === "server") expect(options.verifyAccount).not.toHaveBeenCalled();
    await prepared.dispose();
  });
  it("validates the token via the configured API and never follows credential-bearing redirects", async () => {
    const { options } = await fixture();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "user" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const prepared = await new LocalMulticaContext({ ...options, verifyAccount: undefined }).prepare(scope, new AbortController().signal);
    expect(fetch).toHaveBeenCalledWith("https://example.test/api/me", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer mul_test_credential" } }));
    await prepared.dispose();
  });
  it("keeps simultaneous query configurations separate and cleans crash remnants only at initialization", async () => {
    const { options, context } = await fixture();
    await context.initialize(); await writeFile(join(options.root, "old-secret"), "test");
    const restarted = new LocalMulticaContext(options); await restarted.initialize();
    expect(await readdir(options.root)).toEqual([]);
    const [first, second] = await Promise.all([restarted.prepare(scope, new AbortController().signal), restarted.prepare({ ...scope, workspaceId: "second-workspace" }, new AbortController().signal)]);
    expect(first.env.MULTICA_TASK_CONFIG_ROOT).not.toBe(second.env.MULTICA_TASK_CONFIG_ROOT);
    await first.dispose(); expect(await stat(second.env.MULTICA_TASK_CONFIG_ROOT!)).toBeDefined(); await second.dispose();
  });
});
