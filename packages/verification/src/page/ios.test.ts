// @vitest-environment node
import { expect, it } from "vitest";
import { checkoutMedia, flattenAccessibility, iosActionSchema } from "./ios.js";

it("flattens the accessibility tree to on-screen targetable elements in tree order", () => {
  const frame = { x: 0, y: 0, width: 10, height: 10 };
  const elements = flattenAccessibility([
    {
      type: "Application",
      AXLabel: "Multica (Dev)",
      frame,
      children: [
        { type: "Group", frame, children: [
          { type: "Button", AXLabel: "Send", AXUniqueId: "composer-send", enabled: false, frame, children: [] },
          { type: "TextField", AXValue: "draft", frame, children: [] },
        ] },
        { type: "Group", frame, children: [] },
        { type: "Button", AXLabel: "q", frame: { x: 0, y: 12, width: 4, height: 4 }, children: [] },
      ],
    },
  ]);
  expect(elements).toEqual([
    { type: "Application", id: null, label: "Multica (Dev)", value: null, enabled: null, frame, depth: 0 },
    { type: "Button", id: "composer-send", label: "Send", value: null, enabled: false, frame, depth: 2 },
    { type: "TextField", id: null, label: null, value: "draft", enabled: null, frame, depth: 2 },
  ]);
});

it("keeps media inside the environment checkout", () => {
  expect(checkoutMedia("/env/checkout", ["apps/mobile/assets/icon.png"])).toEqual([
    "/env/checkout/apps/mobile/assets/icon.png",
  ]);
  for (const path of ["../secret.png", "/etc/hosts", "apps/../../escape.png"])
    expect(() => checkoutMedia("/env/checkout", [path])).toThrow(/inside the environment checkout/);
});

it("accepts one targeting form per tap and rejects unknown keys", () => {
  expect(iosActionSchema.parse({ type: "tap", target: { label: "Send" } })).toEqual({
    type: "tap",
    target: { label: "Send" },
    waitSeconds: 0,
  });
  expect(() => iosActionSchema.parse({ type: "tap", target: { label: "Send", x: 1, y: 2 } })).toThrow();
  expect(() => iosActionSchema.parse({ type: "key", key: "f13" })).toThrow();
});
