// @vitest-environment node
import { autorun } from "mobx";
import { describe, expect, it, vi } from "vitest";
import { ComposerService, composerOptionsRequestSignature, mergeComposerOptionsSection, type ComposerOptionsRequest } from "./composer-service";

type Options = { provider: string; loadedAtUnixMs?: number; models?: string[]; skills?: string[]; commands?: string[]; capabilities?: unknown; capabilityCatalog?: { id: string; kind?: string }[] };
const request = (fields: Partial<ComposerOptionsRequest> = {}): ComposerOptionsRequest => ({ targetKey: "t", provider: "p", ...fields });

function deferred() {
  const loads: { resolve(value: Options): void; reject(error: Error): void; request: ComposerOptionsRequest }[] = [];
  const service = new ComposerService<Options>((value) => new Promise((resolve, reject) => { loads.push({ resolve, reject, request: value }); }));
  return { loads, service };
}

describe("loading a target's options", () => {
  it("answers a repeat from what settled, and force reads again", async () => {
    const { loads, service } = deferred();
    const first = service.load(request());
    loads[0]!.resolve({ provider: "p", models: ["a"] });
    expect((await first).models).toEqual(["a"]);
    await service.load(request());
    expect(loads).toHaveLength(1);
    void service.load(request({ force: true })).catch(() => {});
    expect(loads).toHaveLength(2);
  });

  it("shares a load under way with a duplicate, not with a different request", () => {
    const { loads, service } = deferred();
    void service.load(request());
    void service.load(request());
    expect(loads).toHaveLength(1);
    void service.load(request({ cwd: "/other" })).catch(() => {});
    expect(loads).toHaveLength(2);
  });

  it("rejects a superseded load, whose late answer changes nothing", async () => {
    const { loads, service } = deferred();
    const older = service.load(request({ cwd: "/a" }));
    const newer = service.load(request({ cwd: "/b" }));
    loads[1]!.resolve({ provider: "p", models: ["new"] });
    await newer;
    loads[0]!.resolve({ provider: "p", models: ["old"] });
    await expect(older).rejects.toThrow("composer_options_load_superseded");
    expect(service.options("t")?.models).toEqual(["new"]);
    expect(service.status("t")).toBe("ready");
  });

  it("reports a failure and keeps what was shown", async () => {
    const { loads, service } = deferred();
    const first = service.load(request());
    loads[0]!.resolve({ provider: "p", models: ["a"] });
    await first;
    const failing = service.load(request({ force: true }));
    expect(service.status("t")).toBe("loading");
    loads[1]!.reject(new Error("boom"));
    await expect(failing).rejects.toThrow("composer_options_load_failed");
    expect(service.status("t")).toBe("error");
    expect(service.options("t")?.models).toEqual(["a"]);
  });

  it("treats an answer that is not options as a failure", async () => {
    const { loads, service } = deferred();
    const load = service.load(request());
    loads[0]!.resolve({} as Options);
    await expect(load).rejects.toThrow("composer_options_load_failed");
  });

  it("does not load an unnamed target", async () => {
    const { loads, service } = deferred();
    await expect(service.load(request({ targetKey: " " }))).rejects.toThrow("composer_options_load_not_accepted");
    expect(loads).toHaveLength(0);
  });

  it("lets one caller give up without stopping the load for others", async () => {
    const { loads, service } = deferred();
    const controller = new AbortController();
    const leaving = service.load(request({ signal: controller.signal }));
    const staying = service.load(request());
    controller.abort(new Error("left"));
    await expect(leaving).rejects.toThrow("left");
    loads[0]!.resolve({ provider: "p", models: ["a"] });
    expect((await staying).models).toEqual(["a"]);
    const aborted = new AbortController();
    aborted.abort(new Error("already"));
    await expect(service.load(request({ signal: aborted.signal }))).rejects.toThrow("already");
  });

  it("reads again after an invalidation, for that provider or target only", async () => {
    const { loads, service } = deferred();
    const one = service.load(request());
    const two = service.load(request({ targetKey: "other", provider: "q" }));
    loads[0]!.resolve({ provider: "p" }); loads[1]!.resolve({ provider: "q" });
    await Promise.all([one, two]);
    service.invalidate({ providers: ["p"] });
    void service.load(request());
    void service.load(request({ targetKey: "other", provider: "q" }));
    expect(loads).toHaveLength(3);
    expect(service.options("t")).not.toBeNull();
  });

  it("tells an observer of one target about that target", async () => {
    const { loads, service } = deferred();
    const seen: (string[] | undefined)[] = [];
    const stop = autorun(() => seen.push(service.options("t")?.models));
    const other = service.load(request({ targetKey: "other" }));
    loads[0]!.resolve({ provider: "p", models: ["x"] });
    await other;
    const own = service.load(request());
    loads[1]!.resolve({ provider: "p", models: ["a"] });
    await own;
    stop();
    expect(seen).toEqual([undefined, ["a"]]);
  });
});

describe("loading a section", () => {
  const base: Options = { provider: "p", models: ["m"], skills: ["s"], commands: ["c"], capabilities: { a: 1 }, capabilityCatalog: [{ id: "tool" }, { id: "conn", kind: "connector" }] };

  it("keeps the other sections' fields when core arrives", () => {
    const merged = mergeComposerOptionsSection(base, { provider: "p", models: ["new"], skills: [], commands: [], capabilityCatalog: [] }, "core");
    expect(merged).toMatchObject({ models: ["new"], skills: ["s"], commands: ["c"], capabilityCatalog: base.capabilityCatalog });
  });

  it("replaces only connectors when they arrive", () => {
    const merged = mergeComposerOptionsSection(base, { provider: "p", models: ["ignored"], capabilityCatalog: [{ id: "next", kind: "connector" }, { id: "ignored" }] }, "connectors");
    expect(merged.capabilityCatalog).toEqual([{ id: "tool" }, { id: "next", kind: "connector" }]);
    expect(merged.models).toEqual(["m"]);
  });

  it("keeps known connectors when capabilities arrive without any", () => {
    const merged = mergeComposerOptionsSection(base, { provider: "p", skills: ["n"], commands: [], capabilityCatalog: [{ id: "fresh" }] }, "capabilities");
    expect(merged).toMatchObject({ skills: ["n"], models: ["m"] });
    expect(merged.capabilityCatalog).toEqual([{ id: "fresh" }, { id: "conn", kind: "connector" }]);
  });

  it("reports the core section as the target's state too", async () => {
    const { loads, service } = deferred();
    const load = service.load(request({ section: "core" }));
    expect(service.status("t")).toBe("loading");
    expect(service.status("t", "core")).toBe("loading");
    expect(service.status("t", "connectors")).toBeUndefined();
    loads[0]!.resolve({ provider: "p" });
    await load;
    expect(service.status("t")).toBe("ready");
  });
});

describe("a request's signature", () => {
  it("ignores spacing and an empty setting, and not a real difference", () => {
    const signature = composerOptionsRequestSignature;
    expect(signature({ provider: " p ", cwd: " /a " })).toBe(signature({ provider: "p", cwd: "/a", settings: { model: "  " } }));
    expect(signature({ provider: "p", settings: { model: "a" } })).not.toBe(signature({ provider: "p", settings: { model: "b" } }));
    expect(vi.isMockFunction(signature)).toBe(false);
  });
});
