import { z } from "zod";
import { parseWithFallback } from "@multica/core/api/schema";
import {
  AgentMemoryConflictError,
  AgentMemoryRestoreTargetError,
  type AgentMemoryAdapter,
  type AgentMemoryEntry,
  type AgentMemoryTree,
} from "@multica/views/agents";
import { localV2Transport } from "./local-v2-transport";

const entrySchema = z
  .object({
    path: z.string(),
    kind: z.enum(["feedback", "project", "reference"]),
    project_dir: z.string().catch(""),
    title: z.string(),
    description: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    source: z.string().catch(""),
    body: z.string().optional(),
  })
  .transform(
    (e): AgentMemoryEntry => ({
      path: e.path,
      kind: e.kind,
      projectDir: e.project_dir,
      title: e.title,
      description: e.description,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      source: e.source,
      body: e.body,
    }),
  );
const emptyEntry: AgentMemoryEntry = {
  path: "",
  kind: "reference",
  projectDir: "",
  title: "",
  description: "",
  createdAt: "",
  updatedAt: "",
  source: "",
  body: "",
};
const treeSchema = z.object({
  exists: z.boolean().catch(false),
  root: z.string().catch(""),
  index: z.string().catch(""),
  entries: z.array(entrySchema).catch([]),
  projects: z.array(z.object({ dir: z.string(), title: z.string() })).catch([]),
  trash: z
    .array(
      z
        .object({
          trash_path: z.string(),
          original_path: z.string(),
          title: z.string(),
          deleted_at: z.string(),
        })
        .transform((v) => ({
          trashPath: v.trash_path,
          originalPath: v.original_path,
          title: v.title,
          deletedAt: v.deleted_at,
        })),
    )
    .catch([]),
});
const emptyTree: AgentMemoryTree = {
  exists: false,
  root: "",
  index: "",
  entries: [],
  projects: [],
  trash: [],
};
const responseSchema = z.object({
  entry: entrySchema,
  warnings: z.array(z.string()).catch([]),
});
const hitsSchema = z.object({
  hits: z
    .array(
      z.object({ path: z.string(), title: z.string(), snippet: z.string() }),
    )
    .catch([]),
});
const emptySchema = z.object({});
export function createAgentMemoryAdapter(
  request: (method: string, path: string, body?: unknown) => Promise<unknown>,
): AgentMemoryAdapter {
  const call = async (
    method: string,
    id: string,
    suffix = "",
    body?: unknown,
  ) => {
    try {
      return await request(
        method,
        `/local/agents/${encodeURIComponent(id)}/memory${suffix}`,
        body,
      );
    } catch (e) {
      if (e instanceof Error && "kind" in e) {
        if (e.kind === "conflict")
          throw new AgentMemoryConflictError(e.message);
        if (e.kind === "restore_target_exists")
          throw new AgentMemoryRestoreTargetError(e.message);
      }
      throw e;
    }
  };
  const read = async (id: string, suffix: string) =>
    parseWithFallback(
      await call("GET", id, suffix),
      z.object({ entry: entrySchema }),
      { entry: emptyEntry },
      { endpoint: "agent-memory/entry" },
    ).entry;
  return {
    tree: async (id) =>
      parseWithFallback(await call("GET", id), treeSchema, emptyTree, {
        endpoint: "agent-memory",
      }),
    read: (id, path) => read(id, `/entry?path=${encodeURIComponent(path)}`),
    readTrash: (id, path) =>
      read(id, `/entry?trash_path=${encodeURIComponent(path)}`),
    update: async (id, input) =>
      parseWithFallback(
        await call("PUT", id, "/entry", {
          path: input.path,
          title: input.title,
          description: input.description,
          body: input.body,
          expected_updated_at: input.expectedUpdatedAt,
        }),
        responseSchema,
        { entry: emptyEntry, warnings: [] as string[] },
        { endpoint: "agent-memory/update" },
      ),
    remove: async (id, path) => {
      parseWithFallback(
        await call("DELETE", id, `/entry?path=${encodeURIComponent(path)}`),
        z.object({ trash_path: z.string() }),
        { trash_path: "" },
        { endpoint: "agent-memory/delete" },
      );
    },
    search: async (id, query) =>
      parseWithFallback(
        await call("GET", id, `/search?q=${encodeURIComponent(query)}`),
        hitsSchema,
        { hits: [] as { path: string; title: string; snippet: string }[] },
        { endpoint: "agent-memory/search" },
      ).hits,
    restore: async (id, path) =>
      parseWithFallback(
        await call("POST", id, "/restore", { trash_path: path }),
        z.object({ entry: entrySchema }),
        { entry: emptyEntry },
        { endpoint: "agent-memory/restore" },
      ).entry,
    clear: async (id) => {
      parseWithFallback(
        await call("DELETE", id),
        emptySchema,
        {},
        { endpoint: "agent-memory/clear" },
      );
    },
  };
}
export const agentMemoryAdapter = createAgentMemoryAdapter(
  (method, path, body) => localV2Transport().agentMemory(method, path, body),
);
