import type { AgentSettings } from "./agentSettings";
import type { AgentProvider } from "./agentSettings.providers";
import { resolveEnabledEnvForAgent } from "./agentEnv";

export function resolveAgentModel(
  settings: AgentSettings,
  provider: AgentProvider
): string | null {
  if (!settings.customModelEnabledByProvider[provider]) {
    return null;
  }

  const model = settings.customModelByProvider[provider].trim();
  return model.length > 0 ? model : null;
}

export function resolveAgentLaunchEnv(
  settings: AgentSettings,
  provider: AgentProvider
): Record<string, string> {
  return resolveEnabledEnvForAgent({
    rows: settings.agentEnvByProvider[provider] ?? []
  });
}
