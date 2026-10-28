// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerDraftProvider, useComposerDrafts } from "./composer-drafts";
import type { AgentGuiInitSnapshot } from "./protocol";

const initial: AgentGuiInitSnapshot = {
  workspaceId: "workspace", workspaceSlug: "workspace", userId: "user", activeSessionId: "a",
  composerDraftScope: JSON.stringify(["https://api.example.test", ""]),
  locale: "en", theme: "light", local: true, agents: [], sessions: [],
};
let root: Root | undefined;
let container: HTMLDivElement;
let drafts: ReturnType<typeof useComposerDrafts>;
function Probe() { drafts = useComposerDrafts(); return null; }
async function mount(snapshot = initial) {
  if (root) await act(async () => root!.unmount());
  root = createRoot(container);
  await act(async () => root!.render(<ComposerDraftProvider initial={snapshot}><Probe /></ComposerDraftProvider>));
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it.each([
  { userId: "another-user" },
  { workspaceId: "another-workspace" },
  { composerDraftScope: JSON.stringify(["https://another-api.example.test", ""]) },
  { composerDraftScope: JSON.stringify(["https://api.example.test", "side:a:"]) },
])("isolates drafts across scope changes: %j", async (change) => {
  await mount();
  await act(async () => drafts[1]({ "session:a": [{ type: "text", text: "Original scope" }] }));
  await mount({ ...initial, ...change });
  expect(drafts[0]).toEqual({});
  await act(async () => drafts[1]({ "session:a": [{ type: "text", text: "Other scope" }] }));
  await mount();
  expect(drafts[0]["session:a"]?.[0].text).toBe("Original scope");
});

it("does not persist drafts for the cloud GUI", async () => {
  const snapshot = { ...initial, local: false };
  await mount(snapshot);
  await act(async () => drafts[1]({ home: [{ type: "text", text: "Cloud draft" }] }));
  await mount(snapshot);
  expect(drafts[0]).toEqual({});
  expect(sessionStorage.length).toBe(0);
});
