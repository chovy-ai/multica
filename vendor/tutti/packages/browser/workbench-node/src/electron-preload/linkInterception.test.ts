import assert from "node:assert/strict";
import { afterEach, beforeEach } from "node:test";
import test from "node:test";
import { installBrowserNodeLinkInterception } from "./linkInterception.ts";

const originalElement = globalThis.Element;
const originalHTMLAnchorElement = globalThis.HTMLAnchorElement;

beforeEach(() => {
  globalThis.Element = FakeElement as unknown as typeof Element;
  globalThis.HTMLAnchorElement =
    FakeAnchor as unknown as typeof HTMLAnchorElement;
});

afterEach(() => {
  globalThis.Element = originalElement;
  globalThis.HTMLAnchorElement = originalHTMLAnchorElement;
});

test("Browser Node link interception redirects target blank clicks", () => {
  const anchor = new FakeAnchor("https://example.com/popup", "_blank");
  const label = new FakeElement(anchor);
  const scope = new FakeWindowScope();
  const openedUrls: string[] = [];
  const diagnostics: unknown[] = [];

  const dispose = installBrowserNodeLinkInterception({
    reportDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
    scope: scope.asWindow(),
    sendOpenUrl(url) {
      openedUrls.push(url);
    }
  });
  const event = new FakeMouseEvent({
    composedPath: () => [label, anchor],
    target: label
  });

  scope.dispatchClick(event);

  assert.deepEqual(openedUrls, ["https://example.com/popup"]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagationStopped, true);
  assert.equal(event.immediatePropagationStopped, true);
  assert.deepEqual(diagnostics, [
    {
      action: "installed",
      readyState: "loading",
      url: "https://example.com/current"
    },
    {
      action: "open-url",
      button: 0,
      defaultPrevented: true,
      href: "https://example.com/popup",
      modifiers: {
        alt: false,
        ctrl: false,
        meta: false,
        shift: false
      },
      target: "_blank"
    }
  ]);

  dispose();
  assert.equal(scope.listener, null);
});

test("Browser Node link interception leaves modified clicks alone", () => {
  const anchor = new FakeAnchor("https://example.com/popup", "_blank");
  const scope = new FakeWindowScope();
  const openedUrls: string[] = [];

  installBrowserNodeLinkInterception({
    scope: scope.asWindow(),
    sendOpenUrl(url) {
      openedUrls.push(url);
    }
  });
  const event = new FakeMouseEvent({
    composedPath: () => [anchor],
    metaKey: true,
    target: anchor
  });

  scope.dispatchClick(event);

  assert.deepEqual(openedUrls, []);
  assert.equal(event.defaultPrevented, false);
});

test("Browser Node link interception runs before later window listeners", () => {
  const anchor = new FakeAnchor("https://example.com/popup", "_blank");
  const scope = new FakeWindowScope();
  const openedUrls: string[] = [];
  let pageListenerRan = false;

  installBrowserNodeLinkInterception({
    scope: scope.asWindow(),
    sendOpenUrl(url) {
      openedUrls.push(url);
    }
  });
  scope.addEventListener("click", () => {
    pageListenerRan = true;
  });

  scope.dispatchClick(
    new FakeMouseEvent({
      composedPath: () => [anchor],
      target: anchor
    })
  );

  assert.deepEqual(openedUrls, ["https://example.com/popup"]);
  assert.equal(pageListenerRan, false);
});

class FakeElement {
  parentElement: FakeElement | null = null;
  private readonly closestAnchor: FakeAnchor | null;

  constructor(closestAnchor: FakeAnchor | null = null) {
    this.closestAnchor = closestAnchor;
  }

  closest(selector: string): FakeAnchor | null {
    return selector === "a[href]" ? this.closestAnchor : null;
  }
}

class FakeAnchor extends FakeElement {
  private readonly attrs = new Map<string, string>();
  readonly href: string;

  constructor(href: string, target: string | null) {
    super(null);
    this.href = href;
    if (target !== null) {
      this.attrs.set("target", target);
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  override closest(selector: string): FakeAnchor | null {
    return selector === "a[href]" ? this : null;
  }
}

class FakeMouseEvent {
  defaultPrevented = false;
  immediatePropagationStopped = false;
  propagationStopped = false;
  button = 0;
  ctrlKey = false;
  metaKey = false;
  shiftKey = false;
  altKey = false;
  target: unknown;
  private readonly path: () => unknown[];

  constructor(input: {
    composedPath: () => unknown[];
    metaKey?: boolean;
    target: unknown;
  }) {
    this.path = input.composedPath;
    this.metaKey = input.metaKey === true;
    this.target = input.target;
  }

  composedPath(): unknown[] {
    return this.path();
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true;
  }
}

class FakeWindowScope {
  listener: ((event: FakeMouseEvent) => void) | null = null;
  readonly listeners: Array<(event: FakeMouseEvent) => void> = [];

  readonly location = {
    href: "https://example.com/current"
  };

  readonly document = {
    readyState: "loading",
    addEventListener: (
      _event: string,
      listener: (event: FakeMouseEvent) => void
    ) => {
      this.listener = listener;
    },
    removeEventListener: (
      _event: string,
      listener: (event: FakeMouseEvent) => void
    ) => {
      if (this.listener === listener) {
        this.listener = null;
      }
    }
  };

  addEventListener(
    _event: string,
    listener: (event: FakeMouseEvent) => void
  ): void {
    this.listener ??= listener;
    this.listeners.push(listener);
  }

  removeEventListener(
    _event: string,
    listener: (event: FakeMouseEvent) => void
  ): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
    if (this.listener === listener) {
      this.listener = this.listeners[0] ?? null;
    }
  }

  asWindow(): Window {
    return this as unknown as Window;
  }

  dispatchClick(event: FakeMouseEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
      if (event.immediatePropagationStopped) {
        break;
      }
    }
  }
}
