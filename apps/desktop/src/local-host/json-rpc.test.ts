// @vitest-environment node
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { appError, JsonRpcPeer, RpcError } from "./json-rpc";

function pair(left: (method: string, params: unknown) => unknown, right: (method: string, params: unknown) => unknown) {
  const ab = new PassThrough(), ba = new PassThrough();
  return { a: new JsonRpcPeer(ba, ab, left), b: new JsonRpcPeer(ab, ba, right), close: () => { ab.end(); ba.end(); } };
}

describe("JSON-RPC peer", () => {
  it.each([
    ["JSON envelope crosses 1 MiB", "x".repeat((1 << 20) - 1)],
    ["UTF-8 body exceeds 1 MiB", "会话🙂".repeat(200_000)],
  ])("preserves large requests, responses and notifications: %s", async (_name, text) => {
    let notified!: (params: unknown) => void;
    const notification = new Promise((resolve) => { notified = resolve; });
    const { a, b, close } = pair((_method, params) => { notified(params); }, (_method, params) => params);
    const payload = { text };
    try {
      expect(await a.call("echo", payload)).toEqual(payload);
      b.notify("event", payload);
      expect(await notification).toEqual(payload);
      expect(await a.call("echo", { text: "next" })).toEqual({ text: "next" });
    } finally { close(); }
  });

  it("routes calls both ways and preserves application error codes", async () => {
    const { a, b, close } = pair(async (method) => method === "ping" ? { pong: true } : undefined, async (method, params) => {
      if (method === "fail") throw appError("account_mismatch", "other account");
      return { echoed: params };
    });
    expect(await a.call("echo", { x: 1 })).toEqual({ echoed: { x: 1 } });
    expect(await b.call("ping", {})).toEqual({ pong: true });
    await expect(a.call("fail", {})).rejects.toMatchObject({ code: -32000, data: { code: "account_mismatch" } } satisfies Partial<RpcError>);
    close();
  });

  it("handles notifications in order even when a handler is slow", async () => {
    const seen: number[] = [];
    const { a, close } = pair(async () => undefined, async (_method, params) => {
      const seq = (params as { seq: number }).seq;
      if (seq === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push(seq);
    });
    for (const seq of [1, 2, 3]) a.notify("event", { seq });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toEqual([1, 2, 3]);
    close();
  });

  it("rejects pending calls when the peer goes away", async () => {
    const { a, close } = pair(async () => undefined, () => new Promise(() => {}));
    const pending = a.call("hang", {});
    close();
    await expect(pending).rejects.toThrow("connection closed");
  });
});
