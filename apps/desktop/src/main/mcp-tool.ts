import { z } from "zod";

type Row = Record<string, unknown>;

/** A tool an MCP server exposes, with its input schema and handler. */
export interface WorkspaceMcpTool {
  imageResult?: boolean;
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  call(input: Row, signal: AbortSignal): Promise<unknown>;
}
