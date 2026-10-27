import type { MacosChromeCookieImportAdapter } from "@tutti-os/browser-node/chrome-cookie-import/macos";
import type { ChromeProfileImportInput, ChromeProfileImportResult, ChromeProfileList } from "../shared/resource-preview";

export type ChromeCookieSource = MacosChromeCookieImportAdapter;
export interface ChromeProfileImportTarget {
  cookies: Pick<Electron.Cookies, "set" | "flushStore">;
  isAvailable(): boolean;
  reload(): void;
}
interface ImportJob { id: string; requestId: string; controller: AbortController; writing: boolean }
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9:-]{1,160}$/i.test(value);
const result = (status: ChromeProfileImportResult["status"], code?: string): ChromeProfileImportResult => ({ status, imported: 0, failed: 0, skipped: 0, ...(code ? { code } : {}) });

/** Cookie values and source paths never cross the renderer boundary. */
export class ResourceChromeProfileImport {
  private jobs = new Map<string, ImportJob>();
  private disposed = false;
  private platform: NodeJS.Platform;
  private createSource: () => ChromeCookieSource;

  constructor(
    private resolveTarget: (owner: string, id: string) => ChromeProfileImportTarget,
    options: { platform?: NodeJS.Platform; createSource: () => ChromeCookieSource },
  ) {
    this.platform = options.platform ?? process.platform;
    this.createSource = options.createSource;
  }

  async list(): Promise<ChromeProfileList> {
    if (this.platform !== "darwin") return { status: "unavailable", reason: "unsupported-platform" };
    if (this.disposed) return { status: "unavailable", reason: "unavailable" };
    try {
      // A new discovery avoids caching an empty result after Chrome creates a profile.
      const found = await this.createSource().discoverChromeCookieProfiles();
      if (found.status !== "available") return { status: "unavailable", reason: found.reason === "no-profiles" ? "no-profiles" : "unavailable" };
      const profiles = found.profiles.filter((profile) => profile.source === "chrome").map(({ id, name, email }) => ({ id, name, ...(email ? { email } : {}) }));
      return profiles.length ? { status: "available", profiles } : { status: "unavailable", reason: "no-profiles" };
    } catch { return { status: "unavailable", reason: "unavailable" }; }
  }

  async import(owner: string, input: ChromeProfileImportInput): Promise<ChromeProfileImportResult> {
    if (this.disposed) return result("canceled");
    if (this.platform !== "darwin") return result("failed", "unsupported-platform");
    if (!input || !validId(input.id) || !validId(input.requestId) || typeof input.profileId !== "string" || input.profileId.length > 256) return result("failed", "invalid-request");
    if (this.jobs.has(owner)) return result("failed", "busy");
    let target: ChromeProfileImportTarget;
    try { target = this.resolveTarget(owner, input.id); }
    catch { return result("failed", "invalid-target"); }
    const job: ImportJob = { id: input.id, requestId: input.requestId, controller: new AbortController(), writing: false };
    this.jobs.set(owner, job);
    try {
      const source = this.createSource();
      const discovered = await source.discoverChromeCookieProfiles();
      if (job.controller.signal.aborted || !target.isAvailable()) return result("canceled");
      // Resolve the opaque id again in main; renderer input cannot nominate a path or Dia profile.
      const profile = discovered.status === "available" ? discovered.profiles.find((profile) => profile.source === "chrome" && profile.id === input.profileId) : undefined;
      if (!profile) return result("failed", "profile-not-found");
      const prepared = await source.prepareChromeCookieImport(profile.id, job.controller.signal);
      if (job.controller.signal.aborted || prepared.status === "canceled" || !target.isAvailable()) return result("canceled");
      if (prepared.status === "failed") return result("failed", prepared.failureCode);

      // Cancellation is a barrier before the first write, never a partial rollback promise.
      job.writing = true;
      let imported = 0, failed = 0;
      for (const cookie of prepared.cookies) {
        try { await target.cookies.set(cookie); imported++; }
        catch { failed++; }
      }
      let code: string | undefined;
      try { await target.cookies.flushStore(); }
      catch { code = "flush-failed"; }
      if (imported > 0) target.reload();
      const status = imported > 0 ? (failed > 0 || prepared.skipped > 0 || code ? "partial" : "success") : (failed > 0 || code ? "failed" : "empty");
      return { status, imported, failed, skipped: prepared.skipped, ...(code ? { code } : {}) };
    } catch { return job.controller.signal.aborted ? result("canceled") : result("failed", "import-failed"); }
    finally { this.jobs.delete(owner); }
  }

  cancel(owner: string, requestId: string): boolean {
    const job = this.jobs.get(owner);
    if (!job || job.requestId !== requestId || job.writing) return false;
    job.controller.abort();
    return true;
  }

  closeTab(owner: string, id: string) {
    const job = this.jobs.get(owner);
    if (job?.id === id && !job.writing) job.controller.abort();
  }

  dispose() {
    this.disposed = true;
    for (const job of this.jobs.values()) if (!job.writing) job.controller.abort();
  }
}
