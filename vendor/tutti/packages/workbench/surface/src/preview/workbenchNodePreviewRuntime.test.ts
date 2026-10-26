import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkbenchNodePreviewRuntime } from "./workbenchNodePreviewRuntime.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    }
  };
}

describe("workbenchNodePreviewRuntime", () => {
  it("deduplicates concurrent requests for one preview identity", async () => {
    const runtime = createWorkbenchNodePreviewRuntime();
    const result = deferred<string | null>();
    let captureCount = 0;
    const request = {
      capture: () => {
        captureCount += 1;
        return result.promise;
      },
      identity: "workspace-1:node-1:revision-1",
      nodeId: "node-1"
    };

    const first = runtime.ensure(request);
    const second = runtime.ensure(request);
    result.resolve("data:image/png;base64,ONE=");

    assert.equal(await first, "data:image/png;base64,ONE=");
    assert.equal(await second, "data:image/png;base64,ONE=");
    assert.equal(captureCount, 1);
  });

  it("uses a persisted preview before starting live capture", async () => {
    const runtime = createWorkbenchNodePreviewRuntime();
    let captureCount = 0;

    const preview = await runtime.ensure({
      capture: async () => {
        captureCount += 1;
        return "data:image/png;base64,LIVE=";
      },
      identity: "workspace-1:node-1:revision-1",
      nodeId: "node-1",
      readPersisted: async () => "data:image/png;base64,CACHED="
    });

    assert.equal(preview, "data:image/png;base64,CACHED=");
    assert.equal(captureCount, 0);
    assert.equal(runtime.readLatest("node-1"), preview);
  });

  it("does not negatively cache an unavailable preview", async () => {
    const runtime = createWorkbenchNodePreviewRuntime();
    let captureCount = 0;
    const request = {
      capture: async () => {
        captureCount += 1;
        return captureCount === 1 ? null : "data:image/png;base64,RETRY=";
      },
      identity: "workspace-1:node-1:revision-1",
      nodeId: "node-1"
    };

    assert.equal(await runtime.ensure(request), null);
    assert.equal(await runtime.ensure(request), "data:image/png;base64,RETRY=");
    assert.equal(captureCount, 2);
  });

  it("does not let an older identity overwrite a newer node preview", async () => {
    const runtime = createWorkbenchNodePreviewRuntime();
    const oldResult = deferred<string | null>();
    const newResult = deferred<string | null>();
    const persisted: string[] = [];

    const oldRequest = runtime.ensure({
      capture: () => oldResult.promise,
      identity: "workspace-1:node-1:revision-1",
      nodeId: "node-1",
      writePersisted(value: string) {
        persisted.push(`old:${value}`);
      }
    });
    const newRequest = runtime.ensure({
      capture: () => newResult.promise,
      identity: "workspace-1:node-1:revision-2",
      nodeId: "node-1",
      writePersisted(value: string) {
        persisted.push(`new:${value}`);
      }
    });

    newResult.resolve("data:image/png;base64,NEW=");
    assert.equal(await newRequest, "data:image/png;base64,NEW=");
    oldResult.resolve("data:image/png;base64,OLD=");
    assert.equal(await oldRequest, "data:image/png;base64,OLD=");

    assert.equal(runtime.readLatest("node-1"), "data:image/png;base64,NEW=");
    assert.equal(
      runtime.read("workspace-1:node-1:revision-1"),
      "data:image/png;base64,OLD="
    );
    assert.deepEqual(persisted, ["new:data:image/png;base64,NEW="]);
  });

  it("reselecting a cached identity fences an older pending request", async () => {
    const runtime = createWorkbenchNodePreviewRuntime();
    const oldResult = deferred<string | null>();
    const persisted: string[] = [];

    assert.equal(
      await runtime.ensure({
        capture: async () => "data:image/png;base64,NEW=",
        identity: "workspace-1:node-1:revision-new",
        nodeId: "node-1"
      }),
      "data:image/png;base64,NEW="
    );
    const oldRequest = runtime.ensure({
      capture: () => oldResult.promise,
      identity: "workspace-1:node-1:revision-old",
      nodeId: "node-1",
      writePersisted(value: string) {
        persisted.push(value);
      }
    });

    assert.equal(
      await runtime.ensure({
        identity: "workspace-1:node-1:revision-new",
        nodeId: "node-1"
      }),
      "data:image/png;base64,NEW="
    );
    oldResult.resolve("data:image/png;base64,OLD=");
    assert.equal(await oldRequest, "data:image/png;base64,OLD=");

    assert.equal(runtime.readLatest("node-1"), "data:image/png;base64,NEW=");
    assert.deepEqual(persisted, []);
  });

  it("contains synchronous adapter failures and continues fallback", async () => {
    const runtime = createWorkbenchNodePreviewRuntime();

    assert.equal(
      await runtime.ensure({
        capture: () => "data:image/png;base64,FALLBACK=",
        identity: "workspace-1:node-sync:revision-1",
        nodeId: "node-sync",
        readPersisted() {
          throw new Error("sync read failure");
        },
        writePersisted() {
          throw new Error("sync write failure");
        }
      }),
      "data:image/png;base64,FALLBACK="
    );
  });

  it("persists successful capture without awaiting the write", async () => {
    const runtime = createWorkbenchNodePreviewRuntime();
    const writes: string[] = [];

    const preview = await runtime.ensure({
      capture: async () => "data:image/png;base64,WRITE=",
      identity: "workspace-1:node-1:revision-1",
      nodeId: "node-1",
      writePersisted(value: string) {
        writes.push(value);
      }
    });

    assert.equal(preview, "data:image/png;base64,WRITE=");
    assert.deepEqual(writes, ["data:image/png;base64,WRITE="]);
  });
});
