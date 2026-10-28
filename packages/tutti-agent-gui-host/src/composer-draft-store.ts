import { createStore } from "zustand/vanilla";
import type { Dispatch, SetStateAction } from "react";
import type { AgentComposerDraft } from "../../../vendor/tutti/packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiNodeTypes";

export type ComposerDrafts = Record<string, AgentComposerDraft>;

interface ComposerDraftState {
  drafts: ComposerDrafts;
  setDrafts: Dispatch<SetStateAction<ComposerDrafts>>;
}

/** Only unsent text crosses a GUI document lifetime; upload state stays local. */
export function createComposerDraftStore(storage?: Storage, namespace?: string) {
  const key = namespace ? `multica:composer-drafts:v1:${namespace}` : null;
  let drafts: ComposerDrafts = {};
  if (storage && key) {
    try {
      const raw = storage.getItem(key);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        drafts = Object.fromEntries(Object.entries(saved).flatMap(([scope, prompt]) =>
          (scope === "home" || scope.startsWith("session:")) && typeof prompt === "string" && prompt.length
            ? [[scope, [{ type: "text", text: prompt }]]]
            : []));
      }
    } catch (error) {
      console.warn("Could not restore composer drafts", error);
    }
  }

  const store = createStore<ComposerDraftState>()((set, get) => ({
    drafts,
    setDrafts: (update) => {
      const current = get().drafts;
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;
      if (storage && key) {
        const prompts = Object.fromEntries(Object.entries(next).flatMap(([scope, draft]) => {
          const prompt = draft[0].text;
          return prompt.length ? [[scope, prompt]] : [];
        }));
        try {
          // Save before notifying React. Tab navigation can destroy this document
          // before a render effect or an asynchronous parent request runs.
          if (Object.keys(prompts).length) storage.setItem(key, JSON.stringify(prompts));
          else storage.removeItem(key);
        } catch (error) {
          console.warn("Could not save composer drafts", error);
        }
      }
      set({ drafts: next });
    },
  }));
  return store;
}

export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>;
