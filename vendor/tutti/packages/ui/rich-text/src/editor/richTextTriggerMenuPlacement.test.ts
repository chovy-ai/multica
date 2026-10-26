import assert from "node:assert/strict";
import test from "node:test";
import { resolveRichTextTriggerMenuPlacement } from "./richTextTriggerMenuPlacement.ts";

const cursorRect = {
  left: 40,
  top: 100,
  bottom: 120
};

test("rich text trigger menu placement keeps the default menu below the cursor", () => {
  assert.deepEqual(
    resolveRichTextTriggerMenuPlacement({
      cursorRect,
      menuOffset: 6,
      menuPlacement: "bottom-start",
      viewportHeight: 720
    }),
    {
      type: "point",
      alignY: "start",
      point: {
        x: 40,
        y: 126
      }
    }
  );
});

test("rich text trigger menu placement can anchor the menu above the cursor", () => {
  assert.deepEqual(
    resolveRichTextTriggerMenuPlacement({
      cursorRect,
      menuOffset: 8,
      menuPlacement: "top-start",
      viewportHeight: 720
    }),
    {
      type: "point",
      alignY: "end",
      point: {
        x: 40,
        y: 92
      }
    }
  );
});

test("rich text trigger menu placement flips upward only when the lower side is constrained", () => {
  const unconstrainedPlacement = resolveRichTextTriggerMenuPlacement({
    cursorRect,
    menuOffset: 6,
    menuPlacement: "auto-start",
    viewportHeight: 720
  });
  assert.equal(unconstrainedPlacement.type, "point");
  assert.equal(unconstrainedPlacement.alignY, "start");

  assert.deepEqual(
    resolveRichTextTriggerMenuPlacement({
      cursorRect: {
        left: 40,
        top: 500,
        bottom: 520
      },
      menuOffset: 6,
      menuPlacement: "auto-start",
      viewportHeight: 560
    }),
    {
      type: "point",
      alignY: "end",
      point: {
        x: 40,
        y: 494
      }
    }
  );
});

test("rich text trigger menu placement can anchor above the editor surface", () => {
  assert.deepEqual(
    resolveRichTextTriggerMenuPlacement({
      cursorRect,
      editorRect: {
        left: 160,
        top: 340,
        bottom: 520,
        width: 600
      },
      menuAnchor: "editor",
      menuOffset: 8,
      menuPlacement: "top-start",
      viewportHeight: 900,
      viewportWidth: 1280
    }),
    {
      type: "point",
      alignY: "end",
      boundaryPoint: {
        x: 460,
        y: 430
      },
      point: {
        x: 160,
        y: 332
      },
      width: 600
    }
  );
});

test("rich text trigger editor anchored menu leaves height to the surface alignment", () => {
  const tallPlacement = resolveRichTextTriggerMenuPlacement({
    cursorRect,
    editorRect: {
      left: 160,
      top: 340,
      bottom: 520,
      width: 600
    },
    estimatedSize: {
      width: 360,
      height: 256
    },
    menuAnchor: "editor",
    menuOffset: 8,
    menuPlacement: "top-start",
    viewportHeight: 900,
    viewportWidth: 1280
  });

  const shortPlacement = resolveRichTextTriggerMenuPlacement({
    cursorRect,
    editorRect: {
      left: 160,
      top: 340,
      bottom: 520,
      width: 600
    },
    estimatedSize: {
      width: 360,
      height: 120
    },
    menuAnchor: "editor",
    menuOffset: 8,
    menuPlacement: "top-start",
    viewportHeight: 900,
    viewportWidth: 1280
  });

  assert.deepEqual(shortPlacement, tallPlacement);
  assert.deepEqual(shortPlacement, {
    type: "point",
    alignY: "end",
    boundaryPoint: {
      x: 460,
      y: 430
    },
    point: {
      x: 160,
      y: 332
    },
    width: 600
  });
});

test("rich text trigger editor anchored menu can anchor below the editor surface", () => {
  assert.deepEqual(
    resolveRichTextTriggerMenuPlacement({
      cursorRect,
      editorRect: {
        left: 160,
        top: 340,
        bottom: 520,
        width: 600
      },
      menuAnchor: "editor",
      menuOffset: 8,
      menuPlacement: "bottom-start",
      viewportHeight: 900,
      viewportWidth: 1280
    }),
    {
      type: "point",
      alignY: "start",
      boundaryPoint: {
        x: 460,
        y: 430
      },
      point: {
        x: 160,
        y: 528
      },
      width: 600
    }
  );
});

test("rich text trigger editor anchored menu stays within viewport width", () => {
  assert.deepEqual(
    resolveRichTextTriggerMenuPlacement({
      cursorRect,
      editorRect: {
        left: 20,
        top: 340,
        bottom: 520,
        width: 600
      },
      menuAnchor: "editor",
      menuOffset: 8,
      menuPlacement: "top-start",
      viewportHeight: 900,
      viewportWidth: 520
    }),
    {
      type: "point",
      alignY: "end",
      boundaryPoint: {
        x: 320,
        y: 430
      },
      point: {
        x: 12,
        y: 332
      },
      width: 496
    }
  );
});
