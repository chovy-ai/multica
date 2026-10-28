import { app } from "electron";
import { join } from "node:path";
import type { TerminalCliSource } from "../shared/terminal-cli";

export function bundledCliSource(): TerminalCliSource {
  const appPath = app.getAppPath();
  return {
    kind: app.isPackaged ? "packaged" : "development",
    appPath,
    cliPath: join(appPath, "resources", "bin", process.platform === "win32" ? "multica.exe" : "multica")
      .replace("app.asar", "app.asar.unpacked"),
  };
}

export function bundledCliPath(): string {
  return bundledCliSource().cliPath;
}
