import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";

// Keep the tab interactions, store and coordinator real; page contents and
// cache-derived titles do not participate in pointer gesture recognition.
vi.mock("@multica/views/layout", () => ({
  useTabPresentation: (_url: string, title: string) => ({
    visual: { kind: "icon", icon: "ListTodo" },
    title,
  }),
  ResourceLeadingVisual: () => <span />,
}));

vi.mock("@/routes", async () => {
  const { createMemoryRouter } = await import("react-router-dom");
  return {
    createAppRouter: () =>
      createMemoryRouter([
        { path: "/", element: null },
        { path: "/acme/issues", element: <p>Issue page</p> },
        { path: "/acme/agents", element: <p>Agents list page</p> },
        { path: "/acme/agents/designer", element: <p>Access settings page</p> },
        { path: "/acme/inbox", element: <p>Inbox page</p> },
      ]),
  };
});

import { TabBar } from "./tab-bar";
import { TabContent } from "./tab-content";
import { getActiveTab, useTabStore } from "@/stores/tab-store";
import { getAppRouter } from "@/platform/tab-coordinator";

// jsdom has no PointerEvent or layout. Give the real drag sensor primary
// pointer coordinates and four adjacent 160px tabs for collision detection.
class TestPointerEvent extends MouseEvent {
  readonly isPrimary: boolean;
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit) {
    super(type, init);
    this.isPrimary = init.isPrimary ?? true;
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const frame = this.closest<HTMLElement>("[data-tab-id]");
      const index = frame
        ? useTabStore.getState().byWorkspace.acme.tabs.findIndex(
            (tab) => tab.id === frame.dataset.tabId,
          )
        : -1;
      return new DOMRect(index < 0 ? 0 : index * 160, 0, index < 0 ? 640 : 160, 36);
    },
  );
});

let queryClient: QueryClient;
let agentsId: string;
let designerId: string;
let inboxId: string;

beforeEach(() => {
  const store = useTabStore.getState();
  store.reset();
  store.switchWorkspace("acme");
  agentsId = store.openTab("/acme/agents", "Agents");
  designerId = store.openTab("/acme/agents/designer?view=access", "Designer", {
    activate: true,
  });
  inboxId = store.openTab("/acme/inbox", "Inbox");
  queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale="en" resources={RESOURCES}>
        <TabBar />
        <TabContent />
      </I18nProvider>
    </QueryClientProvider>,
  );
});

afterEach(async () => {
  cleanup();
  queryClient.clear();
  // The drag sensor retains its document click listener for 50ms after drop.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

afterAll(() => {
  getAppRouter().dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function tabOrder() {
  return useTabStore.getState().byWorkspace.acme.tabs.map((tab) => tab.id);
}

function pressTab(name: string) {
  const target = screen.getByRole("button", { name });
  const x = target.getBoundingClientRect().left + 80;
  fireEvent.pointerDown(target, { button: 0, clientX: x, clientY: 18, isPrimary: true });
  return { target, x };
}

function clickTab(name: string, dx = 0, dy = 0) {
  const { target, x } = pressTab(name);
  fireEvent.pointerMove(document, { clientX: x + dx, clientY: 18 + dy });
  fireEvent.pointerUp(document, { clientX: x + dx, clientY: 18 + dy });
  fireEvent.click(target);
}

function expectPage(id: string, url: string, text: string) {
  const active = getActiveTab(useTabStore.getState());
  expect(active?.id).toBe(id);
  expect(active?.url).toBe(url);
  const { pathname, search } = getAppRouter().state.location;
  expect(`${pathname}${search}`).toBe(url);
  expect(screen.getByText(text)).toBeVisible();
  expect(screen.getByRole("button", { name: active!.title }))
    .toHaveAttribute("data-tab-active", "true");
}

it.each([
  [0, 0],
  [0, 6],
  [0, -6],
  [4, 4],
  [5, 6],
  [-5, -6],
])("switches on one click with pointer movement (%ipx, %ipx)", (dx, dy) => {
  const originalOrder = tabOrder();
  clickTab("Agents", dx, dy);
  expectPage(agentsId, "/acme/agents", "Agents list page");
  expect(tabOrder()).toEqual(originalOrder);
});

it("keeps selection, route and content synchronized through repeated tab switches", () => {
  for (let i = 0; i < 10; i++) {
    clickTab("Agents", 0, 6);
    expectPage(agentsId, "/acme/agents", "Agents list page");
    clickTab("Inbox", 4, 4);
    expectPage(inboxId, "/acme/inbox", "Inbox page");
    clickTab("Designer", 0, -6);
    expectPage(designerId, "/acme/agents/designer?view=access", "Access settings page");
  }
});

it.each([-6, 6])("starts a drag after %ipx of horizontal movement and suppresses its click", (dx) => {
  const { target, x } = pressTab("Agents");
  fireEvent.pointerMove(document, { clientX: x + dx, clientY: 18 });
  expect(target).toHaveClass("opacity-60");
  fireEvent.pointerUp(document, { clientX: x + dx, clientY: 18 });
  fireEvent.click(target);
  expectPage(designerId, "/acme/agents/designer?view=access", "Access settings page");
});

it("reorders tabs on a horizontal drag without changing the active page", () => {
  const originalOrder = tabOrder();
  const { target, x } = pressTab("Agents");
  fireEvent.pointerMove(document, { clientX: x + 6, clientY: 18 });
  fireEvent.pointerMove(document, { clientX: x + 320, clientY: 18 });
  fireEvent.pointerUp(document, { clientX: x + 320, clientY: 18 });
  fireEvent.click(target);
  expect(tabOrder()).toEqual([originalOrder[0], designerId, inboxId, agentsId]);
  expectPage(designerId, "/acme/agents/designer?view=access", "Access settings page");
});
