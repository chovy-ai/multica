import { useCallback, useEffect, useState } from "react";
import {
  AGENT_GUI_PROVIDER_RAIL_PREFERENCES_EVENT,
  agentGUIProviderRailOrderStorageKey,
  parseAgentGUIProviderRailPreferences,
  serializeAgentGUIProviderRailPreferences,
  type AgentGUIProviderRailPreferences
} from "../model/agentGuiProviderRailOrder";

function readAgentGUIProviderRailPreferences(
  storageKey: string
): AgentGUIProviderRailPreferences {
  return parseAgentGUIProviderRailPreferences(
    globalThis.localStorage?.getItem(storageKey)
  );
}

export function useAgentGUIProviderRailPreferences(): {
  persistPreferences: (preferences: AgentGUIProviderRailPreferences) => void;
  preferences: AgentGUIProviderRailPreferences;
} {
  const storageKey = agentGUIProviderRailOrderStorageKey();
  const [preferences, setPreferences] =
    useState<AgentGUIProviderRailPreferences>(() =>
      readAgentGUIProviderRailPreferences(storageKey)
    );

  useEffect(() => {
    const refreshPreferences = () => {
      setPreferences(readAgentGUIProviderRailPreferences(storageKey));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        refreshPreferences();
      }
    };
    globalThis.addEventListener?.("storage", handleStorage);
    globalThis.addEventListener?.(
      AGENT_GUI_PROVIDER_RAIL_PREFERENCES_EVENT,
      refreshPreferences
    );
    return () => {
      globalThis.removeEventListener?.("storage", handleStorage);
      globalThis.removeEventListener?.(
        AGENT_GUI_PROVIDER_RAIL_PREFERENCES_EVENT,
        refreshPreferences
      );
    };
  }, [storageKey]);

  const persistPreferences = useCallback(
    (nextPreferences: AgentGUIProviderRailPreferences) => {
      setPreferences(nextPreferences);
      globalThis.localStorage?.setItem(
        storageKey,
        serializeAgentGUIProviderRailPreferences(nextPreferences)
      );
      globalThis.dispatchEvent?.(
        new Event(AGENT_GUI_PROVIDER_RAIL_PREFERENCES_EVENT)
      );
    },
    [storageKey]
  );

  return { persistPreferences, preferences };
}
