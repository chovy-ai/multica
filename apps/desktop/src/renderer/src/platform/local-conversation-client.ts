import { z } from "zod";
import { parseWithFallback } from "@multica/core/api/schema";
import { LOCAL_CONVERSATION_METHODS, LOCAL_CONVERSATION_PROTOCOL_VERSION, type LocalConversationCapabilities, type LocalConversationClient, type LocalConversationScope } from "@multica/tutti-agent-gui-host/local-protocol";

export function localRuntimeRestartMessage(chinese: boolean): string {
  return chinese ? "桌面后台需要更新，请在运行中的任务结束后完全退出并重新打开 Multica。刷新页面无法完成更新。" : "The desktop runtime needs updating. After running tasks finish, fully quit and reopen Multica. Reloading the page does not update it.";
}

export class LocalRuntimeUpdateRequired extends Error {
  constructor() {
    super(localRuntimeRestartMessage((document.documentElement.lang || navigator.language).startsWith("zh")));
  }
}

function unknownMethod(error: unknown): boolean {
  return error instanceof Error && /(?:^|Error: )Unknown local conversation request(?:: [\w]+)?$/.test(error.message);
}

const capabilitiesSchema = z.object({ protocolVersion: z.number().int().positive(), methods: z.array(z.string()) });
interface CompatibleClient extends LocalConversationClient {
  check(scope: LocalConversationScope): Promise<LocalConversationCapabilities | null>;
  needsRestart(scope: LocalConversationScope): boolean;
  subscribeCompatibility(listener: () => void): () => void;
}
const clients = new WeakMap<LocalConversationClient, CompatibleClient>();

/** Cache only in this renderer lifetime: a main-process restart reloads the renderer. */
export function getLocalConversationClient(raw: LocalConversationClient): CompatibleClient {
  const existing = clients.get(raw);
  if (existing) return existing;
  const checks = new Map<string, Promise<LocalConversationCapabilities | null>>();
  const resolved = new Map<string, LocalConversationCapabilities | null>();
  const outdated = new Set<string>();
  const unsupported = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  const key = (scope: LocalConversationScope) => JSON.stringify([scope.userId, scope.workspaceId]);
  const markOutdated = (scope: LocalConversationScope) => {
    const id = key(scope);
    if (outdated.has(id)) return;
    outdated.add(id);
    listeners.forEach((listener) => listener());
  };
  const client: CompatibleClient = {
    check(scope) {
      const id = key(scope);
      let pending = checks.get(id);
      if (!pending) {
        pending = raw.request(scope, "capabilities", {}).then((value) => {
          const capabilities = parseWithFallback<LocalConversationCapabilities>(value, capabilitiesSchema, { protocolVersion: -1, methods: [] }, { endpoint: "local-conversation.capabilities" });
          if (capabilities.protocolVersion !== LOCAL_CONVERSATION_PROTOCOL_VERSION || Object.keys(LOCAL_CONVERSATION_METHODS).some((method) => !capabilities.methods.includes(method))) markOutdated(scope);
          resolved.set(id, capabilities);
          return capabilities;
        }).catch((error: unknown) => {
          if (unknownMethod(error)) { markOutdated(scope); resolved.set(id, null); return null; }
          checks.delete(id);
          throw error;
        });
        checks.set(id, pending);
      }
      return pending;
    },
    async request(scope, method, params) {
      const capabilities = resolved.has(key(scope)) ? resolved.get(key(scope))! : await client.check(scope);
      if (capabilities && (capabilities.protocolVersion !== LOCAL_CONVERSATION_PROTOCOL_VERSION || !capabilities.methods.includes(method))) throw new LocalRuntimeUpdateRequired();
      // Legacy runtimes can still handle their existing methods. Never replay a
      // rejected mutation or fall back to transferring entire attachment bytes.
      if ((!capabilities && method === "capabilities") || unsupported.get(key(scope))?.has(method)) throw new LocalRuntimeUpdateRequired();
      try { return await raw.request(scope, method, params); }
      catch (error) {
        if (!unknownMethod(error)) throw error;
        const methods = unsupported.get(key(scope)) ?? new Set<string>();
        methods.add(method); unsupported.set(key(scope), methods);
        markOutdated(scope);
        throw new LocalRuntimeUpdateRequired();
      }
    },
    subscribe: (listener) => raw.subscribe(listener),
    needsRestart: (scope) => outdated.has(key(scope)),
    subscribeCompatibility(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  clients.set(raw, client);
  clients.set(client, client);
  return client;
}
