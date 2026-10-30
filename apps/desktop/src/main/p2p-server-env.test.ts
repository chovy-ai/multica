// @vitest-environment node
import { describe, expect, it } from "vitest";
import { p2pServerEnv } from "./p2p-server-env";

describe("p2pServerEnv", () => {
  it("passes the build-time registry to the daemon", () => {
    expect(p2pServerEnv({}, " http://203.0.113.7:8090 ")).toEqual({
      MULTICA_DAEMON_P2P_SERVER_URL: "http://203.0.113.7:8090",
    });
  });

  it("uses the deployed registry when the build has no configured address", () => {
    expect(p2pServerEnv({}, undefined)).toEqual({ MULTICA_DAEMON_P2P_SERVER_URL: "http://101.33.221.22:8090" });
    expect(p2pServerEnv({}, "  ")).toEqual({ MULTICA_DAEMON_P2P_SERVER_URL: "http://101.33.221.22:8090" });
  });

  it("keeps a registry already set in the environment", () => {
    expect(
      p2pServerEnv({ MULTICA_DAEMON_P2P_SERVER_URL: "http://127.0.0.1:8090" }, "http://203.0.113.7:8090"),
    ).toEqual({});
    expect(p2pServerEnv({ MULTICA_DAEMON_P2P_SERVER_URL: "http://127.0.0.1:8090" }, undefined)).toEqual({});
  });
});
