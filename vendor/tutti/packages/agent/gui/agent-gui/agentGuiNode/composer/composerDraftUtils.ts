const GOAL_MODE_SLASH_COMMAND = "/goal";

export const AGENT_COMPOSER_PASTED_TEXT_FILE_PREFIX = "pasted-text";

export function agentComposerTextByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

export function goalDraftObjectiveFromPrompt(prompt: string): string | null {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?\s*$/u.exec(prompt);
  return match ? (match[1] ?? "") : null;
}

export function buildGoalModePrompt(objective: string): string {
  return objective.trim() === ""
    ? GOAL_MODE_SLASH_COMMAND
    : `${GOAL_MODE_SLASH_COMMAND} ${objective}`;
}
