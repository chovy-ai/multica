import type { AgentThinkingContentVM } from "./agentMessageRowVM";
import type { AgentToolCallVM } from "./agentToolCallVM";

export type AgentToolGroupEntryVM =
  | {
      kind: "thinking";
      thinking: AgentThinkingContentVM;
    }
  | {
      kind: "tool-call";
      call: AgentToolCallVM;
    };

export interface AgentToolGroupRowVM {
  kind: "tool-group";
  id: string;
  expansionKey?: string;
  turnId: string;
  grouped: boolean;
  calls: AgentToolCallVM[];
  summary?: string | null;
  entries: AgentToolGroupEntryVM[];
  occurredAtUnixMs: number | null;
}
