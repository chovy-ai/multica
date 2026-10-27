// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { ResourceChromeProfileImport, type ChromeCookieSource } from "./resource-chrome-profile-import";

type ProfileId = Parameters<ChromeCookieSource["prepareChromeCookieImport"]>[0];
const firstId = "chrome:fixture-one" as ProfileId;
const secondId = "chrome:fixture-two" as ProfileId;
const cookie = { url: "https://example.test/", name: "login", value: "fixture-secret", path: "/", httpOnly: true, secure: true };
const input = { id: "tab-one", profileId: secondId, requestId: "request-one" };
let source: ChromeCookieSource;
let target: { cookies: { set: ReturnType<typeof vi.fn<() => Promise<void>>>; flushStore: ReturnType<typeof vi.fn<() => Promise<void>>> }; isAvailable: ReturnType<typeof vi.fn<() => boolean>>; reload: ReturnType<typeof vi.fn<() => void>> };
let resolveTarget: ReturnType<typeof vi.fn<() => typeof target>>;
let service: ResourceChromeProfileImport;
beforeEach(() => {
  source = {
    discoverChromeCookieProfiles: vi.fn(async () => ({ status: "available" as const, profiles: [
      { id: firstId, name: "Personal", source: "chrome" as const, email: "fixture@example.test", avatarDataUrl: "private-avatar" },
      { id: secondId, name: "Work", source: "chrome" as const },
      { id: "dia:fixture" as ProfileId, name: "Dia", source: "dia" as const },
    ] })),
    prepareChromeCookieImport: vi.fn(async () => ({ status: "ready" as const, cookies: [cookie], skipped: 0 })),
  };
  target = { cookies: { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) }, isAvailable: vi.fn(() => true), reload: vi.fn() };
  resolveTarget = vi.fn(() => target);
  service = new ResourceChromeProfileImport(resolveTarget, { platform: "darwin", createSource: () => source });
});

it("discovers Chrome profiles without preparing cookies or exposing source-only fields", async () => {
  expect(await service.list()).toEqual({ status: "available", profiles: [
    { id: firstId, name: "Personal", email: "fixture@example.test" }, { id: secondId, name: "Work" },
  ] });
  expect(source.prepareChromeCookieImport).not.toHaveBeenCalled();
  expect(target.cookies.set).not.toHaveBeenCalled();
});

it("imports only the explicitly selected profile, flushes before reloading, and allows a repeat", async () => {
  target.reload.mockImplementation(() => expect(target.cookies.flushStore).toHaveBeenCalled());
  expect(await service.import("owner", input)).toEqual({ status: "success", imported: 1, failed: 0, skipped: 0 });
  expect(resolveTarget).toHaveBeenCalledWith("owner", "tab-one");
  expect(source.prepareChromeCookieImport).toHaveBeenCalledWith(secondId, expect.any(AbortSignal));
  expect(target.cookies.set).toHaveBeenCalledWith(cookie);
  expect(target.reload).toHaveBeenCalledOnce();
  await service.import("owner", { ...input, requestId: "request-two" });
  expect(target.cookies.set).toHaveBeenCalledTimes(2);
});

it("rejects malformed requests, foreign targets and undiscovered or Dia profiles before preparing", async () => {
  expect((await service.import("owner", { ...input, profileId: "dia:fixture" })).code).toBe("profile-not-found");
  expect((await service.import("owner", { ...input, profileId: "../../Cookies" })).code).toBe("profile-not-found");
  expect((await service.import("owner", { ...input, requestId: "" })).code).toBe("invalid-request");
  resolveTarget.mockImplementation(() => { throw new Error("foreign workspace"); });
  expect((await service.import("foreign-owner", input)).code).toBe("invalid-target");
  expect(source.prepareChromeCookieImport).not.toHaveBeenCalled();
});

it("cancels preparation only for the matching owner and receipt, with no writes or refresh", async () => {
  let finish!: (result: Awaited<ReturnType<ChromeCookieSource["prepareChromeCookieImport"]>>) => void;
  vi.mocked(source.prepareChromeCookieImport).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = service.import("owner", input);
  await vi.waitFor(() => expect(source.prepareChromeCookieImport).toHaveBeenCalled());
  expect(service.cancel("foreign-owner", input.requestId)).toBe(false);
  expect(service.cancel("owner", "wrong-request")).toBe(false);
  expect((await service.import("owner", { ...input, requestId: "request-two" })).code).toBe("busy");
  expect(service.cancel("owner", input.requestId)).toBe(true);
  finish({ status: "ready", cookies: [cookie], skipped: 0 });
  expect((await pending).status).toBe("canceled");
  expect(target.cookies.set).not.toHaveBeenCalled();
  expect(target.reload).not.toHaveBeenCalled();
});

it("reports partial success and zero-write outcomes without returning cookie contents", async () => {
  vi.mocked(source.prepareChromeCookieImport).mockResolvedValue({ status: "ready", cookies: [cookie, { ...cookie, name: "rejected" }], skipped: 3 });
  target.cookies.set.mockRejectedValueOnce(new Error("sensitive cookie contents"));
  expect(await service.import("owner", input)).toEqual({ status: "partial", imported: 1, failed: 1, skipped: 3 });
  vi.mocked(source.prepareChromeCookieImport).mockResolvedValue({ status: "ready", cookies: [], skipped: 2 });
  expect(await service.import("owner", input)).toEqual({ status: "empty", imported: 0, failed: 0, skipped: 2 });
  vi.mocked(source.prepareChromeCookieImport).mockResolvedValue({ status: "ready", cookies: [cookie], skipped: 0 });
  target.cookies.set.mockRejectedValue(new Error("sensitive cookie contents"));
  expect(await service.import("owner", input)).toEqual({ status: "failed", imported: 0, failed: 1, skipped: 0 });
});

it.each(["keychain_denied", "keychain_timeout", "snapshot_failed", "cipher_incompatible"])("reports %s without a write", async (failureCode) => {
  vi.mocked(source.prepareChromeCookieImport).mockResolvedValue({ status: "failed", failureStage: "keychain", failureCode });
  expect((await service.import("owner", input)).code).toBe(failureCode);
  expect(target.cookies.set).not.toHaveBeenCalled();
});

it("finishes writes once started even if canceled, and reports flush failures", async () => {
  target.cookies.set.mockImplementation(async () => { expect(service.cancel("owner", input.requestId)).toBe(false); });
  target.cookies.flushStore.mockRejectedValue(new Error("secret storage path"));
  expect(await service.import("owner", input)).toEqual({ status: "partial", imported: 1, failed: 0, skipped: 0, code: "flush-failed" });
});

it("does not start a write after the tab closes or the service is disposed", async () => {
  vi.mocked(source.prepareChromeCookieImport).mockImplementation(async () => {
    service.closeTab("owner", "tab-one");
    return { status: "ready", cookies: [cookie], skipped: 0 };
  });
  expect((await service.import("owner", input)).status).toBe("canceled");
  target.isAvailable.mockReturnValue(false);
  expect((await service.import("owner", { ...input, requestId: "request-two" })).status).toBe("canceled");
  service.dispose();
  expect((await service.import("owner", input)).status).toBe("canceled");
  expect(target.cookies.set).not.toHaveBeenCalled();
});

it("reports unsupported platforms and no Chrome profiles without accessing credentials", async () => {
  const factory = vi.fn(() => source);
  const unsupported = new ResourceChromeProfileImport(resolveTarget, { platform: "linux", createSource: factory });
  expect(await unsupported.list()).toEqual({ status: "unavailable", reason: "unsupported-platform" });
  expect((await unsupported.import("owner", input)).code).toBe("unsupported-platform");
  expect(factory).not.toHaveBeenCalled();
  vi.mocked(source.discoverChromeCookieProfiles).mockResolvedValue({ status: "available", profiles: [] });
  expect(await service.list()).toEqual({ status: "unavailable", reason: "no-profiles" });
});
