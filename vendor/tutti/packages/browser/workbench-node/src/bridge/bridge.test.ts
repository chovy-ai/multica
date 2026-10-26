import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserNodeBridgeApiTree } from "./buildApiTree.ts";
import { isBrowserNodeBridgeHostAllowed } from "./hostPolicy.ts";

test("checks Browser Node bridge host allowlists", () => {
  assert.equal(
    isBrowserNodeBridgeHostAllowed("https://app.example.com/", [
      "*.example.com"
    ]),
    true
  );
  assert.equal(
    isBrowserNodeBridgeHostAllowed("https://example.com/", ["*.example.com"]),
    false
  );
  assert.equal(
    isBrowserNodeBridgeHostAllowed("https://preview.local/", ["*"]),
    true
  );
});

test("builds bridge API trees for allowed methods and requires namespace", async () => {
  assert.throws(
    () =>
      buildBrowserNodeBridgeApiTree({
        call: async () => ({ ok: true, value: null }),
        currentUrl: "https://app.example.com/",
        methods: [],
        namespace: " "
      }),
    /namespace is required/
  );

  const api = buildBrowserNodeBridgeApiTree({
    call: async (method, args) => ({ ok: true, value: { args, method } }),
    currentUrl: "https://app.example.com/",
    methods: [
      {
        hostPatterns: ["*.example.com"],
        name: "agent.send"
      },
      {
        hostPatterns: ["other.example.com"],
        name: "agent.skip"
      }
    ],
    namespace: "__host"
  });

  assert.equal(typeof (api.agent as Record<string, unknown>).send, "function");
  assert.equal((api.agent as Record<string, unknown>).skip, undefined);
  assert.deepEqual(
    await (api.agent as { send: (args: unknown) => Promise<unknown> }).send({
      value: 1
    }),
    { ok: true, value: { args: { value: 1 }, method: "agent.send" } }
  );
});

test("rejects unsafe Browser Node bridge namespace and method segments", () => {
  assert.throws(
    () =>
      buildBrowserNodeBridgeApiTree({
        call: async () => ({ ok: true, value: null }),
        currentUrl: "https://app.example.com/",
        methods: [],
        namespace: "__proto__"
      }),
    /Unsafe Browser Node bridge path segment/
  );

  assert.throws(
    () =>
      buildBrowserNodeBridgeApiTree({
        call: async () => ({ ok: true, value: null }),
        currentUrl: "https://app.example.com/",
        methods: [
          {
            hostPatterns: ["*.example.com"],
            name: "agent.__proto__.send"
          }
        ],
        namespace: "__host"
      }),
    /Unsafe Browser Node bridge path segment/
  );
});
