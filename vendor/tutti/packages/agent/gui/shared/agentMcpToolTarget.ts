export interface AgentMcpToolTarget {
  server: string;
  tool: string;
  displayName: string;
  instruction: string | null;
}

export interface ExtractAgentMcpToolTargetInput {
  input?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  name?: string | null;
  payload?: Record<string, unknown> | null;
  toolName?: string | null;
}

export function extractAgentMcpToolTarget({
  input: providedInput,
  metadata: rawMetadata,
  payload: rawPayload,
  toolName
}: ExtractAgentMcpToolTargetInput): AgentMcpToolTarget | null {
  const payload = objectValue(rawPayload);
  const input = objectValue(providedInput) ?? objectValue(payload?.input);
  const metadata = objectValue(rawMetadata) ?? objectValue(payload?.metadata);
  const toolCall = objectValue(input?.toolCall);
  const request = objectValue(input?.request) ?? objectValue(toolCall?.request);
  const requestMeta = objectValue(request?._meta);
  const parsedToolName = parseMcpToolName(
    firstString(toolName, stringValue(metadata?.toolName))
  );
  const server = firstString(
    stringValue(metadata?.server),
    stringValue(metadata?.serverName),
    stringValue(metadata?.mcpServer),
    stringValue(input?.server),
    stringValue(input?.server_name),
    stringValue(input?.serverName),
    stringValue(input?.mcpServer),
    stringValue(toolCall?.server),
    stringValue(toolCall?.server_name),
    stringValue(toolCall?.serverName),
    parsedToolName?.server
  );
  const tool = firstString(
    stringValue(metadata?.toolName),
    stringValue(metadata?.tool),
    stringValue(input?.tool),
    stringValue(input?.toolName),
    stringValue(toolCall?.tool),
    stringValue(toolCall?.toolName),
    parsedToolName?.tool
  );
  if (!server || !tool) {
    return null;
  }
  return {
    server,
    tool,
    displayName: formatAgentMcpToolTarget({ server, tool }),
    instruction:
      firstString(
        formatToolParamsDisplay(requestMeta?.tool_params_display),
        formatObjectInstruction(requestMeta?.tool_params),
        formatObjectInstruction(input?.arguments)
      ) ?? null
  };
}

export function formatAgentMcpToolTarget({
  server,
  tool
}: {
  server: string;
  tool: string;
}): string {
  return `${server} / ${tool}`;
}

function parseMcpToolName(
  value: string | null
): { server: string; tool: string } | null {
  const match = value?.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/i);
  if (!match) {
    return null;
  }
  const server = match[1]?.replace(/_/gu, "-").trim();
  const tool = match[2]?.trim();
  return server && tool ? { server, tool } : null;
}

function firstString(
  ...values: Array<string | null | undefined>
): string | null {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function formatToolParamsDisplay(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value.flatMap((entry) => {
    const record = objectValue(entry);
    const name =
      stringValue(record?.display_name) ??
      stringValue(record?.displayName) ??
      stringValue(record?.name);
    const rawValue = record?.value;
    const formattedValue = formatInstructionValue(rawValue);
    return name && formattedValue ? [`${name}: ${formattedValue}`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatObjectInstruction(value: unknown): string | null {
  const record = objectValue(value);
  if (!record) {
    return stringValue(value);
  }
  const parts = Object.entries(record).flatMap(([key, rawValue]) => {
    const formattedValue = formatInstructionValue(rawValue);
    return formattedValue ? [`${key}: ${formattedValue}`] : [];
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatInstructionValue(value: unknown): string | null {
  if (typeof value === "string") {
    return stringValue(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      const formattedValue = formatInstructionValue(entry);
      return formattedValue ? [formattedValue] : [];
    });
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (objectValue(value)) {
    return stableJsonValue(value);
  }
  return null;
}

function stableJsonValue(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
