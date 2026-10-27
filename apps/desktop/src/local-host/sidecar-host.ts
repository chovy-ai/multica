import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalConversationMethod, LocalConversationMethods, LocalConversationScope } from "@multica/core/local-conversation/protocol";
import {
  fileCommitParamsSchema, fileResolveParamsSchema, initParamsSchema, sidecarRequestParamsSchema, sidecarSessionParamsSchema,
  type HostRequestKind,
} from "@multica/core/local-conversation/wire";
import type { SettingsApplyOutcome } from "./local-settings-tools";
import { appError, type JsonRpcPeer } from "./json-rpc";
import { LocalConversationService } from "./local-conversation-service";
import { generateLocalConversationTitle } from "./local-conversation-title-generator";
import { LocalMulticaContext } from "./local-multica-context";

/** Methods that start model work; a draining host refuses them so a restart interrupts nothing new. */
const STARTS_WORK = new Set<string>(["send", "remoteSend", "fork", "sideCreate", "importSessions"]);
/** Cloud agent turns are driven by this host only; Desktop starts them with remoteSend. */
const HOST_INTERNAL = new Set<string>(["remoteBegin", "remoteUpdate"]);

type Service = Pick<LocalConversationService, "request" | "setCurrentUser" | "setDraining" | "busyCount" | "stop" | "resolveFile" | "adoptFile">;

export interface SidecarHostBridge {
  /** Asks the Desktop connection that originated the current work. */
  hostRequest(kind: HostRequestKind, payload: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(scope: LocalConversationScope, sessionId: string): void;
  timing(record: unknown): void;
}

export interface SidecarHostOptions {
  /** Builds the conversation service for one API URL; tests inject a fake. */
  createService?: (input: { apiUrl: string; dataDir: string; profileDir: string; cliPath: string }, bridge: SidecarHostBridge) => Promise<Service>;
  /** Called once the host has persisted state for a requested shutdown. */
  onShutdown?: () => void;
}

/** Credentials Desktop synced into this daemon profile. */
async function readProfileCredentials(profileDir: string): Promise<{ userId: string; token: string; serverUrl: string }> {
  const userId = (await readFile(join(profileDir, ".desktop-user-id"), "utf8")).trim();
  const config = JSON.parse(await readFile(join(profileDir, "config.json"), "utf8"));
  return { userId, token: config.token, serverUrl: config.server_url };
}

async function createConversationService(input: { apiUrl: string; dataDir: string; profileDir: string; cliPath: string }, bridge: SidecarHostBridge): Promise<Service> {
  const context = new LocalMulticaContext({
    root: join(input.dataDir, "cli-context"),
    apiUrl: input.apiUrl,
    workspaceOperations: true,
    cliPath: input.cliPath,
    readProfile: () => readProfileCredentials(input.profileDir),
    settings: {
      host: (request, signal) => bridge.hostRequest("settings_host", { request }, signal),
      confirmAndApply: async (request, apply, signal) => await bridge.hostRequest("confirmed_operation", { request, apply }, signal) as SettingsApplyOutcome,
    },
    local: (scope) => ({
      list: () => service.request(scope, "list", {}),
      read: (id) => service.request(scope, "read", { id }),
      file: (id) => service.request(scope, "fileRead", { id }),
    }),
    localActions: (scope) => ({ request: (method, params) => service.request(scope, method, params) }),
  });
  await context.initialize();
  // The context only calls back into the service after both exist.
  const service = new LocalConversationService({
    timing: (record) => bridge.timing(record),
    root: input.dataDir,
    apiUrl: input.apiUrl,
    generateTitle: generateLocalConversationTitle,
    prepareContext: (scope, signal, current) => context.prepare(scope, signal, current),
    queueCloudClient: (scope, signal) => context.queueClient(scope, signal),
    notify: (scope, sessionId) => bridge.notify(scope, sessionId),
    chooseDirectory: async (current) => ((await bridge.hostRequest("pick_directory", { current })) as { path: string | null } | null)?.path ?? null,
    choosePreview: async (kind) => ((await bridge.hostRequest("pick_preview", { kind })) as { path: string | null } | null)?.path ?? null,
  });
  return service;
}

/**
 * The sidecar side of the daemon link: owns one conversation service per
 * profile and routes human-facing work back to the Desktop connection that
 * started it.
 */
export function createSidecarHost(peer: () => JsonRpcPeer, options: SidecarHostOptions = {}) {
  const origin = new AsyncLocalStorage<string>();
  const lastConnection = new Map<string, string>();
  let init: ReturnType<typeof initParamsSchema.parse> | undefined;
  let service: Promise<Service> | undefined;
  let serviceApiUrl: string | undefined;
  let activeUser: string | null = null;
  let draining = false;
  let seq = 0;
  let reportedBusy = -1;

  const bridge: SidecarHostBridge = {
    hostRequest: (kind, payload, signal) => {
      const connectionId = origin.getStore() ?? (activeUser ? lastConnection.get(activeUser) : undefined);
      if (!connectionId) return Promise.reject(appError("settings_host_unavailable", "Open Multica Desktop with the same signed-in account to continue"));
      return peer().call("host.request", { connectionId, kind, payload }, signal);
    },
    notify: (scope, sessionId) => {
      peer().notify("event", { seq: ++seq, event: { type: "changed", scope, sessionId } });
      void reportBusy();
    },
    timing: (record) => peer().notify("timing", record),
  };

  const reportBusy = async () => {
    if (!service) return;
    const count = (await service).busyCount();
    if (count === reportedBusy) return;
    reportedBusy = count;
    peer().notify("busy", { count });
  };
  const busyTimer = setInterval(() => void reportBusy(), 1000);
  busyTimer.unref();

  const requireService = async () => {
    if (!service) throw appError("session_required", "Call session.set before sending requests");
    return service;
  };

  const handle = async (method: string, raw: unknown): Promise<unknown> => {
    switch (method) {
      case "init": {
        init = initParamsSchema.parse(raw);
        return {};
      }
      case "session.set": {
        if (!init) throw appError("not_initialized", "The sidecar has not been initialized");
        const params = sidecarSessionParamsSchema.parse(raw);
        if (serviceApiUrl && serviceApiUrl !== params.apiUrl) throw appError("api_url_mismatch", "This daemon profile serves another Multica server");
        // The sidecar is a dedicated process, so its own environment is the
        // provider environment Desktop resolved for the user.
        Object.assign(process.env, params.env);
        serviceApiUrl = params.apiUrl;
        const current = init;
        service ??= (options.createService ?? createConversationService)({ apiUrl: params.apiUrl, dataDir: current.dataDir, profileDir: current.profileDir, cliPath: current.cliPath }, bridge);
        const ready = await service;
        if (activeUser !== params.userId) { activeUser = params.userId; ready.setCurrentUser(params.userId); }
        lastConnection.set(params.userId, params.connectionId);
        return {};
      }
      case "request": {
        const params = sidecarRequestParamsSchema.parse(raw);
        const ready = await requireService();
        if (HOST_INTERNAL.has(params.method)) throw appError("method_not_allowed", `${params.method} is internal to the local conversation host`);
        if (draining && STARTS_WORK.has(params.method)) throw appError("host_draining", "The local conversation service is updating. Try again in a moment.");
        lastConnection.set(params.scope.userId, params.connectionId);
        const result = await origin.run(params.connectionId, () => ready.request(params.scope as LocalConversationScope, params.method as LocalConversationMethod, params.params as LocalConversationMethods[LocalConversationMethod]["params"]));
        void reportBusy();
        return result ?? null;
      }
      case "file.resolve": {
        const params = fileResolveParamsSchema.parse(raw);
        return (await requireService()).resolveFile(params.scope as LocalConversationScope, params.fileRef);
      }
      case "file.commit": {
        const params = fileCommitParamsSchema.parse(raw);
        return { id: await (await requireService()).adoptFile(params.scope as LocalConversationScope, params.tempPath, params.name, params.mimeType) };
      }
      case "drain": {
        draining = true;
        if (!service) return { busy: 0 };
        const ready = await service;
        ready.setDraining(true);
        return { busy: ready.busyCount() };
      }
      case "undrain": {
        draining = false;
        if (service) (await service).setDraining(false);
        return {};
      }
      case "shutdown": {
        clearInterval(busyTimer);
        if (service) await (await service).stop();
        setImmediate(() => options.onShutdown?.());
        return {};
      }
    }
    throw appError("method_not_found", `Unknown sidecar method ${method}`);
  };

  return {
    handle,
    /** Persists state when the daemon disappears without asking first. */
    async stop() {
      clearInterval(busyTimer);
      if (service) await (await service).stop();
    },
  };
}
