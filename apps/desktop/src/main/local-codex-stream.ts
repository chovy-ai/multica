import { codexMessageSeparator, ProviderStream, type runLocalProvider } from "./local-provider-runner";
import type { CodexObject } from "./local-codex-rpc";

type Emit = Parameters<typeof runLocalProvider>[1];
/** Converts app-server items into the existing conversation transcript contract. */
export class CodexTurnStream {
  readonly parser: ProviderStream;
  private text = new Map<string, string>();
  private completed = new Set<string>();
  constructor(private emit: Emit) { this.parser = new ProviderStream("codex", emit); }
  accept(method: string, params: CodexObject): void {
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      if (this.completed.has(params.itemId) || !params.delta) return;
      const prefix = this.text.has(params.itemId) ? "" : codexMessageSeparator(this.parser.output);
      this.text.set(params.itemId, (this.text.get(params.itemId) ?? "") + params.delta);
      this.emit({ type: "text", content: prefix + params.delta }); return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = params.item;
    if (!item || typeof item.id !== "string") return;
    if (method === "item/completed") { if (this.completed.has(item.id)) return; this.completed.add(item.id); }
    if (item.type === "agentMessage" && method === "item/completed") {
      const full = typeof item.text === "string" ? item.text : "";
      const delivered = this.text.get(item.id) ?? "";
      const prefix = full ? codexMessageSeparator(this.parser.output) : "";
      if (full.startsWith(delivered) && full.length > delivered.length) this.emit({ type: "text", content: (delivered ? "" : prefix) + full.slice(delivered.length) });
      this.parser.output += prefix + full; this.text.delete(item.id); return;
    }
    const types: Record<string, string> = { commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", imageGeneration: "image_generation", dynamicToolCall: "dynamic_tool_call" };
    const converted = { ...item, type: types[item.type] ?? item.type,
      ...(item.type === "commandExecution" ? { aggregated_output: item.aggregatedOutput } : {}),
      ...(item.type === "reasoning" ? { text: [...(item.summary ?? []), ...(item.content ?? [])].join("\n") } : {}),
    };
    this.parser.accept(JSON.stringify({ type: method === "item/started" ? "item.started" : "item.completed", item: converted }));
  }
}
