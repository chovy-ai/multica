// @vitest-environment node
import { expect, it } from "vitest";
import { pickSimulatorTarget } from "./ios.js";

const runtime = (
  version: string,
  names: string[],
  extra: Record<string, unknown> = {},
) => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(".", "-")}`,
  name: `iOS ${version}`,
  version,
  platform: "iOS",
  isAvailable: true,
  supportedDeviceTypes: names.map((name) => ({
    identifier: `type.${name.replaceAll(" ", "-")}`,
    name,
  })),
  ...extra,
});

it("picks the newest available iOS runtime and its newest iPhone Pro", () => {
  const target = pickSimulatorTarget({
    runtimes: [
      runtime("26.5", ["iPhone 16 Pro", "iPhone 17 Pro", "iPhone 17 Pro Max", "iPad Pro"]),
      runtime("26.10", ["iPhone 18 Pro"], { isAvailable: false }),
      runtime("18.6", ["iPhone 16 Pro"]),
      { ...runtime("26.9", ["Apple Watch"]), platform: "watchOS", name: "watchOS 26.9" },
    ],
  });
  expect(target).toEqual({
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    runtimeName: "iOS 26.5",
    deviceType: "type.iPhone-17-Pro",
    deviceName: "iPhone 17 Pro",
  });
});

it("compares versions numerically and falls back to any iPhone", () => {
  expect(
    pickSimulatorTarget({
      runtimes: [runtime("26.9", ["iPhone 16"]), runtime("26.10", ["iPhone Air", "iPad mini"])],
    }).deviceName,
  ).toBe("iPhone Air");
});

it("reports a missing runtime as an action for the user", () => {
  expect(() =>
    pickSimulatorTarget({ runtimes: [runtime("26.5", ["iPhone 17 Pro"], { isAvailable: false })] }),
  ).toThrow(/No iOS simulator runtime/);
});
