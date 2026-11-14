export interface AgentMemoryEntry {
  path: string;
  kind: "feedback" | "project" | "reference";
  projectDir: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  body?: string;
  document?: string;
}
export interface AgentMemoryTree {
  exists: boolean;
  root: string;
  index: string;
  entries: AgentMemoryEntry[];
  projects: { dir: string; title: string }[];
  trash: {
    trashPath: string;
    originalPath: string;
    title: string;
    deletedAt: string;
  }[];
}
export interface AgentMemoryAdapter {
  tree(agentId: string): Promise<AgentMemoryTree>;
  read(agentId: string, path: string): Promise<AgentMemoryEntry>;
  readTrash(agentId: string, trashPath: string): Promise<AgentMemoryEntry>;
  update(
    agentId: string,
    input: {
      path: string;
      document: string;
      expectedUpdatedAt: string;
    },
  ): Promise<{ entry: AgentMemoryEntry; warnings: string[] }>;
  remove(agentId: string, path: string): Promise<void>;
  search(
    agentId: string,
    query: string,
  ): Promise<{ path: string; title: string; snippet: string }[]>;
  restore(agentId: string, trashPath: string): Promise<AgentMemoryEntry>;
  clear(agentId: string): Promise<void>;
}
export class AgentMemoryConflictError extends Error {}
export class AgentMemoryRestoreTargetError extends Error {}
