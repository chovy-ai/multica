import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";
import type { LocalV2ChooseRequest, LocalV2RendererEndpoint } from "@multica/core/local-conversation/v2";

/** What the renderer asks Desktop's main process while it talks to the daemon directly. */
export interface LocalV2Bridge {
  /** The daemon's address and the renderer's credentials; read again after they are refused. */
  endpoint(): Promise<LocalV2RendererEndpoint>;
  /** Shows the OS picker and applies the chosen path; null when cancelled. */
  choose(scope: LocalConversationScope, request: LocalV2ChooseRequest): Promise<unknown>;
  /**
   * Performs a daemon host request that needs main: dialogs, Settings, the
   * Side browser, log files. deviceId is "local" or the device that asked.
   */
  hostRequest(deviceId: string, scope: LocalConversationScope, kind: string, payload: Record<string, unknown>): Promise<unknown>;
  /** Applies a folder the user chose on another device's picker; main alone may widen what it reads. */
  chooseRemote(deviceId: string, scope: LocalConversationScope, request: LocalV2ChooseRequest, path: string): Promise<unknown>;
}
