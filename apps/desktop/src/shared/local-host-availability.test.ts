// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localHostAvailabilityMessage } from "./local-host-availability";

describe("local host availability messages", () => {
  it("stays silent while the service works and explains every blocking state", () => {
    expect(localHostAvailabilityMessage(null, false)).toBeNull();
    expect(localHostAvailabilityMessage({ state: "connected" }, false)).toBeNull();
    expect(localHostAvailabilityMessage({ state: "updating" }, true)).toBeTruthy();
    for (const reason of ["daemon_offline", "unsupported", "not_signed_in", "account_mismatch", "incompatible"] as const) {
      expect(localHostAvailabilityMessage({ state: "unavailable", reason }, false)).toBeTruthy();
      expect(localHostAvailabilityMessage({ state: "unavailable", reason }, true)).toBeTruthy();
    }
  });

  it("names the other device for every state of a Device link tab", () => {
    for (const reason of ["daemon_offline", "unsupported", "not_signed_in", "account_mismatch", "incompatible", "device_unreachable", "device_link_off", "device_unknown", "api_url_mismatch"] as const) {
      expect(localHostAvailabilityMessage({ state: "unavailable", reason }, true, "Mac Studio")).toBeTruthy();
    }
    expect(localHostAvailabilityMessage({ state: "unavailable", reason: "device_link_off" }, true, "Mac Studio")).toBe("Mac Studio 已关闭设备互联");
    expect(localHostAvailabilityMessage({ state: "unavailable", reason: "device_unreachable" }, false, "Mac Studio")).toBe("Lost connection to Mac Studio. Reconnecting…");
    expect(localHostAvailabilityMessage({ state: "updating" }, false, "Mac Studio")).toBe("Mac Studio is updating. You can send again shortly.");
  });
});
