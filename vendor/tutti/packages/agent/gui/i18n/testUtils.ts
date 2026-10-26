import {
  setCurrentAgentGuiI18nLocaleForTests,
  type AgentGuiI18nLocale
} from "./runtime.ts";

export function setAgentGuiI18nTestLocale(locale: AgentGuiI18nLocale): void {
  setCurrentAgentGuiI18nLocaleForTests(locale);
}
