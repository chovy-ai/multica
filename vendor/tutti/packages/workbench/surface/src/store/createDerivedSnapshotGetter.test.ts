import assert from "node:assert/strict";
import test from "node:test";
import { createDerivedSnapshotGetter } from "./createDerivedSnapshotGetter.ts";

test("reuses the derived snapshot while the source snapshot reference is stable", () => {
  let sourceSnapshot = { nodes: ["a"] };
  let deriveCalls = 0;
  const getSnapshot = createDerivedSnapshotGetter<
    { nodes: string[] },
    { nodeIds: string[] }
  >({
    deriveSnapshot(snapshot) {
      deriveCalls += 1;
      return {
        nodeIds: snapshot.nodes.slice()
      };
    },
    getSourceSnapshot() {
      return sourceSnapshot;
    }
  });

  const firstSnapshot = getSnapshot();
  const secondSnapshot = getSnapshot();
  assert.equal(secondSnapshot, firstSnapshot);
  assert.equal(deriveCalls, 1);

  sourceSnapshot = { nodes: ["a"] };

  const thirdSnapshot = getSnapshot();
  assert.notEqual(thirdSnapshot, firstSnapshot);
  assert.deepEqual(thirdSnapshot, firstSnapshot);
  assert.equal(deriveCalls, 2);
});
