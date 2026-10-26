import { contextBridge } from "electron";
import {
  buildBrowserNodeBridgeApiTree,
  type BrowserNodeBridgeMethodDescriptor,
  type BrowserNodeBridgeResult
} from "../bridge/index.ts";
export { installBrowserNodeLinkInterception } from "./linkInterception.ts";
export {
  installBrowserNodeGuestInteractionForwarding,
  type BrowserNodeGuestInteractionPayload,
  type BrowserNodeGuestInteractionType
} from "./interactionForwarding.ts";

export interface InstallBrowserNodeGuestBridgeInput {
  call: (
    method: string,
    args: unknown
  ) => Promise<BrowserNodeBridgeResult<unknown>>;
  debug?: boolean;
  methods: readonly BrowserNodeBridgeMethodDescriptor[];
  namespace: string;
}

export function installBrowserNodeGuestBridge({
  call,
  debug = false,
  methods,
  namespace
}: InstallBrowserNodeGuestBridgeInput): void {
  const currentUrl = globalThis.location?.href ?? "";
  const api = buildBrowserNodeBridgeApiTree({
    call,
    currentUrl,
    methods,
    namespace,
    wrapCallable: debug
      ? (methodName, callable) => async (args?: unknown) => {
          console.debug("[browser-node:bridge]", methodName);
          return await callable(args);
        }
      : undefined
  });

  contextBridge.exposeInMainWorld(namespace.trim(), api);
}
