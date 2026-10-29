// @vitest-environment node
import { describe, expect, it } from "vitest";
import { p2pServerEnv } from "./p2p-server-env";

describe("p2pServerEnv", () => {
  it("passes the build-time registry to the daemon", () => {
    expect(p2pServerEnv({}, " http://203.0.113.7:8090 ")).toEqual({
      MULTICA_DAEMON_P2P_SERVER_URL: "http://203.0.113.7:8090",
    });
  });

  it("leaves device links off without a build-time registry", () => {
    expect(p2pServerEnv({}, undefined)).toEqual({});
    expect(p2pServerEnv({}, "  ")).toEqual({});
  });

  it("keeps a registry already set in the environment", () => {
    expect(
      p2pServerEnv({ MULTICA_DAEMON_P2P_SERVER_URL: "http://127.0.0.1:8090" }, "http://203.0.113.7:8090"),
    ).toEqual({});
  });
});
