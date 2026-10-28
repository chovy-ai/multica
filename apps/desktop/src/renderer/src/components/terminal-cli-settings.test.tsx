import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "@multica/views/locales";
import { TerminalCliSettings } from "./terminal-cli-settings";
import type { TerminalCliStatus } from "../../../shared/terminal-cli";

const initial: TerminalCliStatus = { supported: true, bundleAvailable: true, installed: false, managed: false, commandPath: "/test/.local/bin/multica", conflictPath: null, shellFiles: ["/test/.zshrc"], detectedPath: null, currentVersion: null, bundledVersion: { version: "0.7.0", commit: "bcdfa010e" }, versionState: "not_installed", source: { kind: "packaged", appPath: "/test/Multica.app", cliPath: "/test/Multica.app/resources/bin/multica" }, bindingState: "missing" };
let api: { status: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn>; uninstall: ReturnType<typeof vi.fn> };
const mount = () => render(<I18nProvider locale="zh-Hans" resources={RESOURCES}><TerminalCliSettings /></I18nProvider>);
beforeEach(() => {
  api = { status: vi.fn().mockResolvedValue(initial), install: vi.fn(), uninstall: vi.fn() };
  Object.defineProperty(window, "desktopAPI", { configurable: true, value: { terminalCli: api } });
});
afterEach(cleanup);

describe("terminal CLI settings", () => {
  it("installs with a pending state, then offers uninstall and new-terminal instructions", async () => {
    let finish!: (value: unknown) => void;
    api.install.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mount();
    const button = await screen.findByRole("button", { name: "一键安装" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(api.install).toHaveBeenCalledTimes(1);
    finish({ ok: true, status: { ...initial, installed: true, managed: true, versionState: "current", currentVersion: initial.bundledVersion, detectedPath: initial.commandPath } });
    const uninstall = await screen.findByRole("button", { name: "卸载" });
    expect(screen.getByText(/新开一个终端/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "一键安装" })).not.toBeInTheDocument();
    api.uninstall.mockResolvedValue({ ok: true, status: initial });
    fireEvent.click(uninstall);
    await waitFor(() => expect(screen.getByRole("button", { name: "一键安装" })).toBeEnabled());
    expect(screen.queryByText(/新开一个终端/)).not.toBeInTheDocument();
  });

  it("shows conflicts without letting installation replace another CLI", async () => {
    api.status.mockResolvedValue({ ...initial, conflictPath: initial.commandPath });
    mount();
    expect(await screen.findByText(initial.commandPath)).toBeInTheDocument();
    expect(screen.getByText(/原安装方式卸载/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键安装" })).toBeDisabled();
    expect(api.install).not.toHaveBeenCalled();
  });

  it("keeps an installation error visible and supports retry", async () => {
    api.install.mockResolvedValue({ ok: false, error: "filesystem" });
    mount();
    const button = await screen.findByRole("button", { name: "一键安装" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/写入权限/);
    expect(button).toBeEnabled();
  });

  it("shows unavailable bundled binaries and can recover from a failed status check", async () => {
    api.status.mockRejectedValueOnce(new Error("offline"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(/无法检查/);
    api.status.mockResolvedValue({ ...initial, bundleAvailable: false });
    fireEvent.click(screen.getByRole("button", { name: "检查版本" }));
    expect(await screen.findByText(/包内 CLI 缺失/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键安装" })).toBeDisabled();
  });

  it("provides a visible version check and an update action for an older external CLI", async () => {
    const older: TerminalCliStatus = { ...initial, currentVersion: { version: "0.6.2", commit: "123456789" }, detectedPath: "/test/brew/bin/multica", versionState: "update_available" };
    api.status.mockResolvedValue(older);
    api.install.mockResolvedValue({ ok: true, status: { ...initial, managed: true, installed: true, detectedPath: initial.commandPath, currentVersion: initial.bundledVersion, versionState: "current" } });
    mount();
    const button = await screen.findByRole("button", { name: "一键更新" });
    expect(screen.getByText("0.6.2 (123456789)")).toBeInTheDocument();
    expect(screen.getByText("0.7.0 (bcdfa010e)")).toBeInTheDocument();
    expect(screen.getByText(/保留现有安装/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查版本" })).toBeEnabled();
    expect(api.install).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(await screen.findByText(/与当前 Desktop 内置版本一致/)).toBeInTheDocument();
    expect(api.install).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "一键更新" })).not.toBeInTheDocument();
  });

  it("rechecks versions on demand with a loading state, without automatically installing", async () => {
    api.status.mockResolvedValue({ ...initial, managed: true, installed: true, currentVersion: initial.bundledVersion, versionState: "current", detectedPath: initial.commandPath });
    mount();
    expect(await screen.findByText(/与当前 Desktop 内置版本一致/)).toBeInTheDocument();
    let finish!: (value: TerminalCliStatus) => void;
    api.status.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const check = screen.getByRole("button", { name: "检查版本" });
    fireEvent.click(check);
    expect(check).toBeDisabled();
    expect(screen.getByText("检查中…")).toBeInTheDocument();
    finish({ ...initial, managed: true, currentVersion: { version: "0.6.2", commit: null }, detectedPath: initial.commandPath, versionState: "update_available" });
    await waitFor(() => expect(screen.getByRole("button", { name: "一键更新" })).toBeEnabled());
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(api.install).not.toHaveBeenCalled();
  });

  it.each(["newer", "different", "unknown"] as const)("offers explicit matching-version installation for %s versions", async (versionState) => {
    api.status.mockResolvedValue({ ...initial, managed: true, installed: true, detectedPath: initial.commandPath, currentVersion: versionState === "unknown" ? null : { version: "0.8.0", commit: "123456789" }, versionState });
    mount();
    expect(await screen.findByRole("button", { name: "安装匹配版本" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "一键更新" })).not.toBeInTheDocument();
    expect(screen.queryByText(/与当前 Desktop 内置版本一致/)).not.toBeInTheDocument();
    if (versionState === "newer") expect(screen.getByText(/高于 Desktop 内置版本/)).toBeInTheDocument();
    expect(api.install).not.toHaveBeenCalled();
  });

  it("shows a dev source and rebind action for another worktree even when versions match", async () => {
    const source = { kind: "development" as const, appPath: "/test/worktree-b/apps/desktop", cliPath: "/test/worktree-b/apps/desktop/resources/bin/multica" };
    api.status.mockResolvedValue({ ...initial, managed: true, currentVersion: initial.bundledVersion, versionState: "current", detectedPath: initial.commandPath, bindingState: "other", source });
    api.install.mockResolvedValue({ ok: true, status: { ...initial, managed: true, installed: true, currentVersion: initial.bundledVersion, versionState: "current", bindingState: "current", source } });
    mount();
    expect(await screen.findByText("当前开发实例")).toBeInTheDocument();
    expect(screen.getByText(source.cliPath)).toBeInTheDocument();
    expect(screen.getByText(/绑定了其他 Desktop/)).toBeInTheDocument();
    expect(screen.queryByText(/与当前 Desktop 内置版本一致/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "绑定当前开发版" }));
    expect(await screen.findByText(/已绑定当前开发实例/)).toBeInTheDocument();
    expect(api.install).toHaveBeenCalledTimes(1);
  });

  it("offers the dev CLI installation with a source-build recovery message", async () => {
    const source = { kind: "development" as const, appPath: "/test/dev", cliPath: "/test/dev/resources/bin/multica" };
    api.status.mockResolvedValue({ ...initial, bundleAvailable: false, bundledVersion: null, source });
    mount();
    expect(await screen.findByText(/安装 Go 后重新运行 pnpm dev:desktop/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装开发版 CLI" })).toBeDisabled();
  });
});
