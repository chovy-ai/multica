import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

interface Snapshot { exists: boolean; content: string; hash: string; reason?: string }
export interface FileCaptureEvidence {
  request_id: string; tool_id: string; path: string;
  before: Snapshot; after: Snapshot; reason: string;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const MAX_BYTES = 1 << 20;
const excluded = (path: string) => path.split(/[\\/]/).some((part) => [".git", "node_modules", "vendor", "dist", "build", ".cache", ".ssh", ".aws", ".codex", ".claude"].includes(part) || /^\.env(?:\.|$)|\.(?:pem|key)$|^credentials(?:\.json)?$/i.test(part));

/** SDK hooks observe writes; they never change permission decisions or tool inputs. */
export class FileCapture {
  private cwd = "";
  private requestId = "";
  private agents = new Map<string, string>();
  private pending = new Map<string, { request: string; path: string; before: Snapshot; tool: string; input: Record<string, unknown> }>();
  constructor(private emit: (evidence: FileCaptureEvidence) => Promise<void>) {}
  configure(cwd: string) { this.cwd = cwd; }
  begin(requestId: string) { this.requestId = requestId; }
  clear() { this.pending.clear(); this.agents.clear(); }

  private async read(path: string): Promise<Snapshot> {
    const failed = (reason: string): Snapshot => ({ exists: false, content: "", hash: "", reason });
    if (!isAbsolute(this.cwd)) return failed("outside_scope");
    try {
      const root = await realpath(this.cwd);
      const target = resolve(root, path);
      const rel = relative(root, target);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return failed("outside_scope");
      if (excluded(rel)) return failed("excluded");
      let current = root;
      for (const part of rel.split(sep)) {
        current = join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) return failed("outside_scope"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      let handle;
      try { handle = await open(target, "r"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: "", hash: hash("") }; throw error; }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return failed("read_failed");
        if (stat.size > MAX_BYTES) return failed("large_file");
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) return failed("large_file");
        const bytes = buffer.subarray(0, bytesRead);
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (content.includes("\0")) return failed("binary");
        if (content.split("\n").length > 20001) return failed("large_file");
        const after = await handle.stat();
        if (stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) return failed("uncertain");
        return { exists: true, content, hash: hash(content) };
      } finally { await handle.close(); }
    } catch (error) { return failed(error instanceof TypeError ? "binary" : "read_failed"); }
  }

  readonly hooks: Options["hooks"] = {
    SubagentStart: [{ hooks: [async (input) => {
      if ("agent_id" in input && typeof input.agent_id === "string") this.agents.set(input.agent_id, this.requestId);
      return {};
    }] }],
    PreToolUse: [{ matcher: "^(Write|Edit)$", hooks: [async (input, toolId) => {
      if (input.hook_event_name !== "PreToolUse" || !toolId || !this.requestId) return {};
      const data = input.tool_input as Record<string, unknown> | null;
      if (!data || typeof data.file_path !== "string") return {};
      const request = "agent_id" in input && typeof input.agent_id === "string" ? this.agents.get(input.agent_id) ?? "" : this.requestId;
      if (this.pending.size >= 100) return {};
      this.pending.set(toolId, { request, path: data.file_path, before: await this.read(data.file_path), tool: input.tool_name, input: data });
      return {};
    }] }],
    PostToolUse: [{ matcher: "^(Write|Edit)$", hooks: [async (input, toolId) => {
      await this.complete(input, toolId, false); return {};
    }] }],
    PostToolUseFailure: [{ matcher: "^(Write|Edit)$", hooks: [async (input, toolId) => {
      await this.complete(input, toolId, true); return {};
    }] }],
  };

  private async complete(_input: Parameters<HookCallback>[0], toolId: string | undefined, failed: boolean) {
    if (!toolId) return;
    const pending = this.pending.get(toolId); this.pending.delete(toolId);
    if (!pending) return;
    const after = await this.read(pending.path);
    let reason = pending.before.reason ?? after.reason ?? "";
    let expected: string | undefined;
    if (pending.tool === "Write" && typeof pending.input.content === "string") expected = pending.input.content;
    if (pending.tool === "Edit" && typeof pending.input.old_string === "string" && typeof pending.input.new_string === "string" && pending.input.old_string) {
      const old = pending.input.old_string;
      const occurrences = pending.before.content.split(old).length - 1;
      if (occurrences === 1 || (occurrences > 0 && pending.input.replace_all === true)) expected = pending.input.replace_all === true ? pending.before.content.split(old).join(pending.input.new_string) : pending.before.content.replace(old, () => String(pending.input.new_string));
    }
    if (failed && pending.before.hash === after.hash && !reason) return;
    if (failed || expected === undefined || expected !== after.content || !after.exists || !pending.request) reason ||= "uncertain";
    // A broken observation channel must not block or approve the native tool.
    await this.emit({ request_id: pending.request, tool_id: toolId, path: pending.path, before: pending.before, after, reason }).catch(() => {});
  }
}
