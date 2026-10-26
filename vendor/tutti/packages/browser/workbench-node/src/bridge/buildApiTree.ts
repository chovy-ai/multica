import { isBrowserNodeBridgeHostAllowed } from "./hostPolicy.ts";
import type {
  BrowserNodeBridgeApiTree,
  BrowserNodeBridgeCallable,
  BrowserNodeBridgeMeta,
  BrowserNodeBridgeMethodDescriptor,
  BrowserNodeBridgeResult
} from "./types.ts";

type BridgeBranch = Record<string, unknown>;
const reservedBridgeSegments = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
const safeBridgePropertyPattern = /^[A-Za-z_$][\w$-]*$/;

function createBridgeBranch(): BridgeBranch {
  return Object.create(null) as BridgeBranch;
}

function assertSafeBridgeSegment(segment: string): void {
  if (
    reservedBridgeSegments.has(segment) ||
    !safeBridgePropertyPattern.test(segment)
  ) {
    throw new Error(`Unsafe Browser Node bridge path segment: ${segment}`);
  }
}

function ensureBranch(root: BridgeBranch, keys: string[]): BridgeBranch {
  let cursor = root;
  for (const key of keys) {
    assertSafeBridgeSegment(key);
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = createBridgeBranch();
    }
    cursor = cursor[key] as BridgeBranch;
  }
  return cursor;
}

function assignMethod({
  call,
  method,
  root,
  wrapCallable
}: {
  call: (
    method: string,
    args: unknown
  ) => Promise<BrowserNodeBridgeResult<unknown>>;
  method: BrowserNodeBridgeMethodDescriptor;
  root: BridgeBranch;
  wrapCallable?: (
    methodName: string,
    callable: BrowserNodeBridgeCallable
  ) => BrowserNodeBridgeCallable;
}): void {
  const parts = method.name
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  const methodName = parts.join(".");
  const leaf = parts.pop();
  if (!leaf) {
    return;
  }
  assertSafeBridgeSegment(leaf);

  const branch = ensureBranch(root, parts);
  const callable: BrowserNodeBridgeCallable = async (args?: unknown) =>
    await call(methodName, args ?? null);
  branch[leaf] = wrapCallable ? wrapCallable(methodName, callable) : callable;
}

export function buildBrowserNodeBridgeApiTree({
  call,
  currentUrl,
  meta,
  methods,
  namespace,
  wrapCallable
}: {
  call: (
    method: string,
    args: unknown
  ) => Promise<BrowserNodeBridgeResult<unknown>>;
  currentUrl: string;
  meta?: BrowserNodeBridgeMeta;
  methods: readonly BrowserNodeBridgeMethodDescriptor[];
  namespace: string;
  wrapCallable?: (
    methodName: string,
    callable: BrowserNodeBridgeCallable
  ) => BrowserNodeBridgeCallable;
}): BrowserNodeBridgeApiTree {
  const normalizedNamespace = namespace.trim();
  if (normalizedNamespace.length === 0) {
    throw new Error("Browser Node bridge namespace is required");
  }
  assertSafeBridgeSegment(normalizedNamespace);

  const api: BridgeBranch = createBridgeBranch();
  api.meta = meta ?? { runtime: "electron", version: "1" };

  for (const method of methods) {
    if (!isBrowserNodeBridgeHostAllowed(currentUrl, method.hostPatterns)) {
      continue;
    }
    assignMethod({ call, method, root: api, wrapCallable });
  }

  return api as BrowserNodeBridgeApiTree;
}
