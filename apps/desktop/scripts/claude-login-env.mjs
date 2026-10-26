// Explicit development launch mode: retain CLI settings and the local login,
// without inheriting another agent process's provider routing or credentials.
export function withClaudeLoginEnv(inherited) {
  const env = { ...inherited };
  const providerOverrides = new Set([
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]);
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith("ANTHROPIC_") || providerOverrides.has(name)) {
      delete env[key];
    }
  }
  return env;
}
