import assert from "node:assert/strict";
import test from "node:test";
import {
  isBrowserSessionPartitionAllowed,
  resolveBrowserSessionPartition
} from "./session.ts";

test("resolves Browser Node session partitions by session mode", () => {
  assert.equal(
    resolveBrowserSessionPartition({ profileId: null, sessionMode: "shared" }),
    "persist:browser-node-shared"
  );
  assert.equal(
    resolveBrowserSessionPartition({
      profileId: null,
      sessionMode: "incognito"
    }),
    "browser-node-incognito"
  );
  assert.equal(
    resolveBrowserSessionPartition({
      profileId: "work",
      sessionMode: "profile"
    }),
    "persist:browser-node-profile-work"
  );
});

test("allows only Browser Node-owned partitions", () => {
  assert.equal(
    isBrowserSessionPartitionAllowed("persist:browser-node-shared"),
    true
  );
  assert.equal(
    isBrowserSessionPartitionAllowed("browser-node-incognito"),
    true
  );
  assert.equal(
    isBrowserSessionPartitionAllowed("persist:browser-node-profile-work"),
    true
  );
  assert.equal(isBrowserSessionPartitionAllowed("persist:default"), false);
});
