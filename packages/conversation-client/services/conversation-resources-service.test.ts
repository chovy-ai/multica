// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ConversationResourcesService } from "./conversation-resources-service";
import { CONVERSATION_RESOURCES_CAPABILITY } from "@multica/core/local-conversation/resources";

const file = { id: "f1", cwd: "/repo", path: "src/a.ts", kind: "modified", reason: "", added: 1, deleted: 1, changed: true, initial_exists: true, current_exists: true, turn_id: "early-turn" };
const page = (revision = 1) => ({ revision, files: [file], attachments: [], coverage: "complete", reason: "", recorded_from: "now", next_cursor: null });
const capabilities = async () => [CONVERSATION_RESOURCES_CAPABILITY];
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };

describe("conversation resources", () => {
  it("reads all resource pages without requiring transcript history", async () => {
    const request = vi.fn(async (path: string) => path.includes("cursor=") ? { ...page(), files: [{ ...file, id: "f2", path: "b" }] } : { ...page(), next_cursor: "next" });
    const service = new ConversationResourcesService({ request, capabilities }, "conversation");
    await service.refresh();
    expect(service.model.data?.files.map(file => file.id)).toEqual(["f1", "f2"]);
    expect(request.mock.calls.flat().some(path => path.includes("history"))).toBe(false);
  });
  it("coalesces invalidations and does not publish a response older than a new invalidation", async () => {
    const first = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(page(2));
    const service = new ConversationResourcesService({ request, capabilities }, "conversation");
    const release = service.hold();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    service.invalidate(); first.resolve(page(1));
    await vi.waitFor(() => expect(service.model.data?.revision).toBe(2));
    expect(request).toHaveBeenCalledTimes(2); release();
  });
  it("retains the last successful snapshot on error, and rejects malformed data", async () => {
    const request = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ files: [] });
    const service = new ConversationResourcesService({ request, capabilities }, "conversation");
    await service.refresh(); await service.refresh();
    expect(service.model.data?.revision).toBe(1); expect(service.model.error).toBe("offline");
    await service.refresh(); expect(service.model.error).toBe("invalid_resources_response");
    expect(service.model.data?.files[0]?.id).toBe("f1");
  });
  it("drops late data after reset/disposal and starts no new reads while hidden", async () => {
    const pending = deferred<unknown>(); const request = vi.fn(() => pending.promise);
    const service = new ConversationResourcesService({ request, capabilities }, "conversation");
    const release = service.hold(); await vi.waitFor(() => expect(request).toHaveBeenCalled());
    release(); service.invalidate(true); pending.resolve(page());
    await vi.waitFor(() => expect(service.model.data).toBeNull());
    expect(request).toHaveBeenCalledTimes(1);
    service.dispose(); service.invalidate(); expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not load a new endpoint on a daemon without the capability", async () => {
    const request = vi.fn(); const service = new ConversationResourcesService({ request, capabilities: async () => [] }, "conversation");
    await service.refresh(); expect(service.model.supported).toBe(false); expect(request).not.toHaveBeenCalled();
  });
  it("does not install an old detail into a newer resource revision", async () => {
    const detail = deferred<unknown>();
    const request = vi.fn(async (path: string) => path.includes("/changes/") ? detail.promise : page(2));
    const service = new ConversationResourcesService({ request, capabilities }, "conversation");
    service.model.receive(page(1)); const read = service.detail("f1"); await service.refresh();
    detail.resolve({ revision: 1, file, patch: "", before: "a", after: "b" }); await read;
    expect(service.model.details.size).toBe(0);
  });
});

it("starts a fresh active read after a store generation invalidates an in-flight response", async () => {
  const old = deferred<unknown>();
  const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(1));
  const service = new ConversationResourcesService({ request, capabilities }, "conversation");
  const release = service.hold(); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  service.invalidate(true); old.resolve(page(8));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(service.model.data?.revision).toBe(1)); release();
});
it("does not reuse or report a failing detail from a previous store generation", async () => {
  let fail!: (error: Error) => void;
  const old = new Promise<unknown>((_resolve, reject) => { fail = reject; });
  const detail = { revision: 1, file, patch: "", before: "a", after: "b" };
  const request = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(detail);
  const service = new ConversationResourcesService({ request, capabilities }, "conversation");
  service.model.receive(page()); const first = service.detail("f1").catch(() => {});
  service.invalidate(true); service.model.receive(page()); await service.detail("f1");
  fail(new Error("old daemon disconnected")); await first;
  expect(service.model.error).toBe(""); expect(service.model.details.get("f1")).toMatchObject(detail);
});
