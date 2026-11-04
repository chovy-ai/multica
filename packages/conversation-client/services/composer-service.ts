import { action, makeObservable, observable } from "mobx";
import "../mobx-config";

export type ComposerOptionsSection = "core" | "capabilities" | "connectors";
export type ComposerOptionsStatus = "loading" | "ready" | "error";

/** What merging sections of a target's options needs to know about them. */
export interface ComposerOptionsLike {
  provider: string;
  capabilities?: unknown;
  commands?: unknown;
  skills?: unknown;
  capabilityCatalog?: readonly { kind?: string }[] | null;
  slashCommandPolicy?: unknown;
  loadedAtUnixMs?: number;
}

export interface ComposerSettingsLike {
  model?: string | null;
  reasoningEffort?: string | null;
  speed?: string | null;
  planMode?: boolean | null;
  permissionModeId?: string | null;
}

export interface ComposerOptionsRequest {
  targetKey: string;
  provider: string;
  agentSessionId?: string | null;
  cwd?: string | null;
  settings?: ComposerSettingsLike | null;
  section?: ComposerOptionsSection;
  force?: boolean;
  waitForFreshModelCatalog?: boolean;
  signal?: AbortSignal;
}

interface Entry<Options> {
  status: ComposerOptionsStatus;
  provider: string;
  loadingSignature: string | null;
  settledSignature: string | null;
  /** The load this entry waits for; a later one supersedes it. */
  inFlight: { promise: Promise<Options> } | null;
}

/**
 * The composer's choices for each agent target: models, reasoning, permissions.
 * Two requests with the same signature are interchangeable, so a settled result
 * answers a repeat and a load under way answers a duplicate.
 */
export class ComposerService<Options extends ComposerOptionsLike> {
  private readonly optionsByTarget = observable.map<string, Options>([], { deep: false });
  private readonly entries = observable.map<string, Entry<Options>>([], { deep: false });
  private disposed = false;

  constructor(private readonly loader: (request: ComposerOptionsRequest) => Promise<Options>) {
    makeObservable<ComposerService<Options>, "settle" | "begin">(this, { settle: action, begin: action, invalidate: action });
  }

  options(targetKey: string | null | undefined): Options | null {
    return this.optionsByTarget.get(targetKey?.trim() ?? "") ?? null;
  }

  status(targetKey: string | null | undefined, section?: ComposerOptionsSection): ComposerOptionsStatus | undefined {
    return this.entries.get(entryKey(targetKey?.trim() ?? "", section))?.status;
  }

  load(request: ComposerOptionsRequest): Promise<Options> {
    const { signal } = request;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const answer = this.answer(request);
    if (!signal) return answer;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private answer(request: ComposerOptionsRequest): Promise<Options> {
    const targetKey = request.targetKey.trim();
    const provider = request.provider.trim();
    if (!targetKey || !provider) return Promise.reject(new Error("composer_options_load_not_accepted"));
    const signature = composerOptionsRequestSignature({ ...request, provider });
    const key = entryKey(targetKey, request.section);
    const current = this.entries.get(key);
    const known = this.optionsByTarget.get(targetKey);
    if (!request.force && current?.status === "ready" && current.settledSignature === signature && known) return Promise.resolve(known);
    if (current?.status === "loading" && current.loadingSignature === signature && current.inFlight) return current.inFlight.promise;
    return this.begin(request, targetKey, provider, signature, current);
  }

  private begin(request: ComposerOptionsRequest, targetKey: string, provider: string, signature: string, current: Entry<Options> | undefined): Promise<Options> {
    const inFlight = {} as { promise: Promise<Options> };
    inFlight.promise = this.loader(request).then(
      (options) => this.settle(targetKey, request.section, inFlight, options),
      () => this.settle(targetKey, request.section, inFlight, null),
    );
    this.setEntry(targetKey, request.section, { status: "loading", provider, loadingSignature: signature, settledSignature: current?.settledSignature ?? null, inFlight });
    return inFlight.promise;
  }

  private settle(targetKey: string, section: ComposerOptionsSection | undefined, inFlight: object, options: Options | null): Options {
    const current = this.entries.get(entryKey(targetKey, section));
    if (this.disposed) throw new Error("composer_service_disposed");
    if (current?.inFlight !== inFlight) throw new Error("composer_options_load_superseded");
    const settled = (status: ComposerOptionsStatus): Entry<Options> => ({
      ...current, status, loadingSignature: null, inFlight: null,
      settledSignature: status === "ready" ? current.loadingSignature : current.settledSignature,
    });
    if (!options || typeof options.provider !== "string") {
      this.setEntry(targetKey, section, settled("error"));
      throw new Error("composer_options_load_failed");
    }
    this.setEntry(targetKey, section, settled("ready"));
    const merged = section ? mergeComposerOptionsSection(this.optionsByTarget.get(targetKey), options, section) : options;
    this.optionsByTarget.set(targetKey, merged);
    return merged;
  }

  /** The core section is also the target's overall state. */
  private setEntry(targetKey: string, section: ComposerOptionsSection | undefined, entry: Entry<Options>) {
    this.entries.set(entryKey(targetKey, section), entry);
    if (section === "core") this.entries.set(entryKey(targetKey, undefined), entry);
  }

  /** Forgets what answers repeats; what is shown stays until a new load replaces it. */
  invalidate(filter: { providers?: readonly string[]; targetKeys?: readonly string[]; sections?: readonly ComposerOptionsSection[] } = {}): void {
    const { providers, targetKeys, sections } = filter;
    for (const [key, entry] of [...this.entries]) {
      const [targetKey, section] = key.split("\u0000") as [string, string];
      if (section && sections?.length && !sections.includes(section as ComposerOptionsSection)) continue;
      const anyFilter = providers?.length || targetKeys?.length;
      if (anyFilter && !providers?.includes(entry.provider) && !targetKeys?.includes(targetKey)) continue;
      this.entries.set(key, { ...entry, settledSignature: null, loadingSignature: null });
    }
  }

  dispose(): void { this.disposed = true; }
}

function entryKey(targetKey: string, section: ComposerOptionsSection | undefined): string {
  return `${targetKey}\u0000${section ?? ""}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Two requests with the same signature are interchangeable. */
export function composerOptionsRequestSignature(input: { agentSessionId?: string | null; provider?: string; cwd?: string | null; settings?: ComposerSettingsLike | null }): string {
  const text = (value: string | null | undefined) => value?.trim() || null;
  const settings = input.settings;
  return JSON.stringify({
    agentSessionId: text(input.agentSessionId), provider: input.provider?.trim() ?? "", cwd: input.cwd?.trim() ?? "",
    settings: {
      model: text(settings?.model), reasoningEffort: text(settings?.reasoningEffort), speed: text(settings?.speed),
      planMode: typeof settings?.planMode === "boolean" ? settings.planMode : null, permissionModeId: text(settings?.permissionModeId),
    },
  });
}

/** Each section answers for its own fields, and connectors load apart from the rest of the catalog. */
export function mergeComposerOptionsSection<Options extends ComposerOptionsLike>(existing: Options | undefined, incoming: Options, section: ComposerOptionsSection): Options {
  if (!existing) return incoming;
  if (section === "core") {
    return { ...existing, ...incoming, skills: existing.skills, capabilityCatalog: existing.capabilityCatalog, commands: existing.commands };
  }
  const connector = (capability: { kind?: string }) => capability.kind === "connector";
  const existingCatalog = existing.capabilityCatalog ?? [];
  const incomingCatalog = incoming.capabilityCatalog ?? [];
  if (section === "connectors") {
    return { ...existing, capabilityCatalog: [...existingCatalog.filter((item) => !connector(item)), ...incomingCatalog.filter(connector)], loadedAtUnixMs: incoming.loadedAtUnixMs };
  }
  const incomingConnectors = incomingCatalog.filter(connector);
  return {
    ...existing,
    capabilities: incoming.capabilities ?? existing.capabilities, commands: incoming.commands, skills: incoming.skills,
    capabilityCatalog: [...incomingCatalog.filter((item) => !connector(item)), ...(incomingConnectors.length ? incomingConnectors : existingCatalog.filter(connector))],
    loadedAtUnixMs: incoming.loadedAtUnixMs,
  };
}
