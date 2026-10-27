import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseWithFallback } from "@multica/core/api/schema";
import { AttachmentResponseSchema } from "@multica/core/api/schemas";
import type { AvatarFile } from "./local-avatar-file";
import type { WorkspaceMcpTool, WorkspaceToolOptions } from "./local-workspace-tools";
import { SettingsOperationError } from "../shared/settings-operation-error";

export interface AgentAvatarOptions {
  workspaceId: string;
  userId: string;
  conversationId: string;
  receiptsRoot: string;
  readFile(path: string, signal: AbortSignal): Promise<AvatarFile>;
  request: WorkspaceToolOptions["request"];
}
const identity = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const inputShape = { agent_id: identity, file_path: z.string().min(1).max(8192), request_id: identity.max(128) };
const agentSchema = z.object({ id: identity, workspace_id: identity, avatar_url: z.string().nullable() });
const resultSchema = z.object({ agent_id: identity, workspace_id: identity, attachment_id: identity, avatar_url: z.string().min(1), status: z.literal("updated") });
const uploadSchema = AttachmentResponseSchema.pick({ id: true, url: true }).extend({ id: identity, url: z.string().min(1) });
const uploadedShape = { attachment_id: identity, upload_url: z.string().min(1) };
const stateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("uploading") }),
  z.object({ status: z.literal("uploaded"), ...uploadedShape }),
  z.object({ status: z.literal("updating"), ...uploadedShape }),
  z.object({ status: z.literal("completed"), result: resultSchema }),
]);
type State = z.infer<typeof stateSchema>;
const savedSchema = z.object({ fingerprint: z.string(), state: stateSchema });
const flights = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rejected = (error: unknown) => error instanceof SettingsOperationError && error.status !== undefined && error.status >= 400 && error.status < 500;

// The API may resolve a raw object URL to /api/avatars/<signature>/<storage key>.
function matchesUpload(avatar: string | null, uploaded: z.infer<typeof uploadSchema>, workspaceId: string): boolean {
  if (!avatar) return false;
  if (avatar === uploaded.url) return true;
  const path = (value: string) => decodeURIComponent(new URL(value, "https://multica.invalid").pathname);
  try {
    const uploadPath = path(uploaded.url);
    const marker = `/workspaces/${workspaceId}/`;
    const index = uploadPath.lastIndexOf(marker);
    if (index < 0) return false;
    const key = uploadPath.slice(index);
    return key.startsWith(`${marker}${uploaded.id}.`) && path(avatar).endsWith(key);
  } catch { return false; }
}

/** One durable operation spans upload and update; an unknown upload is never replayed. */
export function createAgentAvatarTool(options: AgentAvatarOptions): WorkspaceMcpTool {
  return {
    name: "upload_agent_avatar",
    description: "Upload a local PNG/JPEG/GIF/WebP image (up to 5 MB) and set a defined agent's avatar in this workspace. Only files in this conversation's working directory or explicitly selected files/folders are readable. Supply an absolute file_path. Reuse request_id with identical arguments on retries; uploaded images are retained when the avatar update fails. Does not generate images or execute the agent.",
    inputSchema: inputShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    call: async (raw, signal) => {
      const input = z.object(inputShape).strict().parse(raw);
      const fingerprint = hash([input.agent_id, input.file_path]);
      const path = join(options.receiptsRoot, hash([options.userId, options.workspaceId, options.conversationId, input.request_id]) + ".json");
      const active = flights.get(path);
      if (active) {
        if (active.fingerprint !== fingerprint) throw new Error("This request_id belongs to different avatar input");
        return active.result;
      }
      const run = async () => {
        signal.throwIfAborted();
        const loadAgent = async () => {
          const agent = parseWithFallback<z.infer<typeof agentSchema> | null>(await options.request("GET", `/api/agents/${input.agent_id}`, undefined, signal), agentSchema, null, { endpoint: "GET /api/agents/:id" });
          if (!agent || agent.workspace_id !== options.workspaceId) throw new Error("Agent was not confirmed in the selected workspace");
          return agent;
        };
        const agent = await loadAgent();
        const loadSaved = async () => {
          const saved = savedSchema.parse(JSON.parse(await readFile(path, "utf8")));
          if (saved.fingerprint !== fingerprint) throw new Error("This request_id belongs to different avatar input");
          return saved.state;
        };
        const save = async (state: State) => {
          const temporary = `${path}.${randomUUID()}`;
          try {
            await writeFile(temporary, JSON.stringify({ fingerprint, state }), { mode: 0o600, flag: "wx" });
            await rename(temporary, path);
          } finally { await rm(temporary, { force: true }); }
        };
        let state: State | undefined;
        try { state = await loadSaved(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (!state) {
          const image = await options.readFile(input.file_path, signal);
          signal.throwIfAborted();
          await mkdir(options.receiptsRoot, { recursive: true, mode: 0o700 });
          try {
            const file = await open(path, "wx", 0o600);
            try { await file.writeFile(JSON.stringify({ fingerprint, state: { status: "uploading" } })); await file.sync(); }
            finally { await file.close(); }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            state = await loadSaved();
          }
          if (!state) {
            const form = new FormData();
            form.append("file", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.name);
            let raw: unknown;
            try { raw = await options.request("POST", "/api/upload-file", form, signal); }
            catch (error) {
              if (rejected(error)) await rm(path);
              throw error;
            }
            const uploaded = parseWithFallback<z.infer<typeof uploadSchema> | null>(raw, uploadSchema, null, { endpoint: "POST /api/upload-file" });
            if (!uploaded) throw new Error("Upload outcome is unknown: the server did not confirm an attachment ID and URL. Do not upload again with a new request_id.");
            state = { status: "uploaded", attachment_id: uploaded.id, upload_url: uploaded.url };
            await save(state);
          }
        }
        if (state.status === "completed") return state.result;
        if (state.status === "uploading") throw new Error("The previous upload outcome is unknown. Inspect current state before choosing a new request_id; this upload will not be replayed.");
        const uploaded = { id: state.attachment_id, url: state.upload_url };
        const complete = async (current: z.infer<typeof agentSchema>) => {
          if (current.id !== agent.id || !matchesUpload(current.avatar_url, uploaded, options.workspaceId)) throw new Error("The server did not confirm the uploaded image as this agent's avatar. Inspect current state before retrying.");
          const result = resultSchema.parse({ agent_id: current.id, workspace_id: current.workspace_id, attachment_id: uploaded.id, avatar_url: current.avatar_url, status: "updated" });
          await save({ status: "completed", result });
          return result;
        };
        if (matchesUpload(agent.avatar_url, uploaded, options.workspaceId)) return complete(agent);
        if (state.status === "updating") throw new Error(`The previous avatar update outcome is unknown (attachment ${uploaded.id}). Read the agent before choosing a new request_id; the uploaded image will not be uploaded again.`);
        await save({ ...state, status: "updating" });
        try {
          const raw = await options.request("PUT", `/api/agents/${agent.id}`, { avatar_url: uploaded.url }, signal);
          const updated = parseWithFallback<z.infer<typeof agentSchema> | null>(raw, agentSchema, null, { endpoint: "PUT /api/agents/:id" });
          return await complete(updated && updated.workspace_id === options.workspaceId ? updated : await loadAgent());
        } catch (error) {
          if (rejected(error)) {
            await save(state);
            throw error;
          }
          signal.throwIfAborted();
          const current = await loadAgent();
          if (matchesUpload(current.avatar_url, uploaded, options.workspaceId)) return complete(current);
          throw new Error(`Avatar update was not confirmed (attachment ${uploaded.id}). The image is retained; retry with the same request_id to check current state.`, { cause: error });
        }
      };
      const result = run(); flights.set(path, { fingerprint, result });
      try { return await result; } finally { flights.delete(path); }
    },
  };
}
