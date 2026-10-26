export interface BrowserNodeBridgeError {
  code: string;
  message: string;
  params?: Record<string, unknown>;
}

export type BrowserNodeBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BrowserNodeBridgeError };

export interface BrowserNodeBridgeCallPayload {
  args: unknown;
  method: string;
}

export interface BrowserNodeBridgeMeta {
  runtime: "electron";
  version: string;
}

export interface BrowserNodeBridgeMethodDescriptor {
  readonly defaultErrorCode?: string;
  readonly hostPatterns: readonly string[];
  readonly name: string;
}

export type BrowserNodeBridgeCallable = (
  args?: unknown
) => Promise<BrowserNodeBridgeResult<unknown>>;

export interface BrowserNodeBridgeApiTree {
  meta: BrowserNodeBridgeMeta;
  [key: string]: unknown;
}
