// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostStorage } from "../host/storage.js";
import { JobService } from "../host/jobs.js";
import { Bindings } from "../sources/bindings.js";
import { DeviceLease } from "./device-lease.js";
import { Environments } from "./environments.js";
import { environmentSchema } from "../contracts/resources.js";

it("reads bounded, redacted environment logs and reports truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verification-log-read-"));
  const storage = await HostStorage.open({
    projectRoot: directory,
    stateRoot: join(directory, "state"),
  });
  const jobs = await JobService.open(storage);
  const environments = new Environments(
    storage,
    jobs,
    new Bindings(),
    new DeviceLease(join(directory, "device.lock"), storage.root),
    directory,
  );
  const host = { projectRef: storage.projectRef, environments };
  try {
    const environmentId = randomUUID(),
      folder = join(directory, "state/environments", environmentId);
    await mkdir(folder);
    await writeFile(
      join(directory, "state/environments", `${environmentId}.json`),
      JSON.stringify(
        environmentSchema.parse({
          schemaVersion: 1,
          environmentId,
          projectRef: host.projectRef,
          commit: "0".repeat(40),
          checkout: directory,
          mode: "desktop",
          dataMode: "fixture",
          state: "prepared",
          apiOrigin: "http://test.invalid",
          components: {},
        }),
      ),
    );
    await writeFile(
      join(folder, "prepare.log"),
      'Authorization: Bearer test-created-token\npassword="test-password"\n',
    );
    await writeFile(join(folder, "prepare.log.truncated"), "truncated");
    const page = await host.environments.readLog(
      environmentId,
      "prepare",
      0,
      32000,
    );
    expect(page).toMatchObject({ truncated: true, hasMore: false });
    expect(page.text).toContain("[REDACTED]");
    expect(page.text).not.toContain("test-created-token");
    expect(page.text).not.toContain("test-password");
    await expect(
      host.environments.readLog(environmentId, "../session" as "prepare"),
    ).rejects.toThrow();
  } finally {
    await jobs.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
