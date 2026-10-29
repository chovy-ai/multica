// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localFileScheme } from "./local-file-protocol";

describe("local conversation file protocol", () => {
  it("allows cross-protocol fetches from the packaged file:// renderer", () => {
    expect(localFileScheme).toMatchObject({
      scheme: "multica-local-file",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    });
  });

  it("keeps CSP and service worker privileges at their defaults", () => {
    expect(localFileScheme.privileges?.bypassCSP).not.toBe(true);
    expect(localFileScheme.privileges?.allowServiceWorkers).not.toBe(true);
  });
});
