// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localHostAvailabilityMessage } from "./local-host-availability";

describe("local host availability messages", () => {
  it("stays silent while the service works and explains every blocking state", () => {
    expect(localHostAvailabilityMessage(null, false)).toBeNull();
    expect(localHostAvailabilityMessage({ state: "connected", sidecar: "ready" }, false)).toBeNull();
    expect(localHostAvailabilityMessage({ state: "connected", sidecar: "idle" }, false)).toBeNull();
    for (const sidecar of ["crashed", "draining"] as const) expect(localHostAvailabilityMessage({ state: "connected", sidecar }, true)).toBeTruthy();
    for (const reason of ["daemon_offline", "unsupported", "not_signed_in", "account_mismatch", "incompatible"] as const) {
      expect(localHostAvailabilityMessage({ state: "unavailable", reason }, false)).toBeTruthy();
      expect(localHostAvailabilityMessage({ state: "unavailable", reason }, true)).toBeTruthy();
    }
  });
});
