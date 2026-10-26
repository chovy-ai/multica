export interface BrowserNodeLoopbackPreviewTarget {
  readonly targetUrl: string;
  readonly workspaceId?: string;
}

export interface BrowserNodeLoopbackPreviewResolver {
  resolveTarget(input: {
    port: number;
    url: string;
  }):
    | BrowserNodeLoopbackPreviewTarget
    | Promise<BrowserNodeLoopbackPreviewTarget | null>
    | null;
}

export interface BrowserNodeLoopbackPreviewRoutingOptions {
  readonly resolver: BrowserNodeLoopbackPreviewResolver;
  readonly fallback?: "deny" | "direct";
  readonly cacheTtlMs?: number;
}
