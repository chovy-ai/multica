// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import * as wire from "./wire";

const root = join(__dirname, "../../../server/internal/daemon/localhost/testdata/protocol");

const schemas: Record<string, ZodType> = {
  "desktop-to-daemon/session.set.params": wire.sessionParamsSchema,
  "desktop-to-daemon/session.set.result": wire.sessionResultSchema,
  "desktop-to-daemon/subscribe.params": wire.subscribeParamsSchema,
  "desktop-to-daemon/subscribe.result": wire.subscribeResultSchema,
  "desktop-to-daemon/request.params": wire.requestParamsSchema,
  "desktop-to-daemon/hostReply.params": wire.hostReplyParamsSchema,
  "desktop-to-daemon/hostReply.error.params": wire.hostReplyParamsSchema,
  "desktop-to-daemon/sidecar.drain.result": wire.drainResultSchema,
  "daemon-to-desktop/event": wire.eventNotificationSchema,
  "daemon-to-desktop/hostRequest": wire.hostRequestNotificationSchema,
  "daemon-to-desktop/hostRequestResolved": wire.hostRequestResolvedSchema,
  "daemon-to-desktop/sidecarStatus": wire.sidecarStatusNotificationSchema,
  "daemon-to-desktop/resync": wire.resyncNotificationSchema,
  "daemon-to-sidecar/init.params": wire.initParamsSchema,
  "daemon-to-sidecar/session.set.params": wire.sidecarSessionParamsSchema,
  "daemon-to-sidecar/request.params": wire.sidecarRequestParamsSchema,
  "daemon-to-sidecar/drain.result": wire.drainResultSchema,
  "daemon-to-sidecar/file.resolve.params": wire.fileResolveParamsSchema,
  "daemon-to-sidecar/file.resolve.result": wire.fileResolveResultSchema,
  "daemon-to-sidecar/file.commit.params": wire.fileCommitParamsSchema,
  "daemon-to-sidecar/file.commit.result": wire.fileCommitResultSchema,
  "sidecar-to-daemon/event.params": wire.sidecarEventParamsSchema,
  "sidecar-to-daemon/busy.params": wire.busyParamsSchema,
  "sidecar-to-daemon/log.params": wire.logParamsSchema,
  "sidecar-to-daemon/host.request.params": wire.hostRequestParamsSchema,
};

function fixtures(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? fixtures(path) : [relative(root, path).replace(/\\/g, "/").replace(/\.json$/, "")];
  });
}

describe("local host wire protocol", () => {
  it("decodes every shared Go fixture losslessly", () => {
    const names = fixtures(root);
    expect(names.sort()).toEqual(Object.keys(schemas).sort());
    for (const name of names) {
      const raw = JSON.parse(readFileSync(join(root, `${name}.json`), "utf8"));
      const parsed = schemas[name]!.safeParse(raw);
      expect(parsed.success, `${name}: ${parsed.error?.message}`).toBe(true);
      expect(parsed.data, name).toEqual(raw);
    }
  });

  it("keeps a connection alive when a newer daemon reports an unknown status", () => {
    expect(wire.sidecarStatusNotificationSchema.parse({ status: "hibernating", instance: "x" }).status).toBe("unknown");
    expect(wire.helloSchema.parse({ apiVersion: 1, sidecar: { status: "ready" } })).toMatchObject({ capabilities: [], sidecar: { busy: 0, crashes: 0, instance: "" } });
  });

  it("rejects requests with fields the daemon would not forward", () => {
    expect(wire.requestParamsSchema.safeParse({ scope: { apiUrl: "a", userId: "u", workspaceId: "w" }, method: "read", params: {}, token: "x" }).success).toBe(false);
  });
});
