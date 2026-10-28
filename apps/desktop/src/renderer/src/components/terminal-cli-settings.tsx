import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { SettingsCard, SettingsRow, SettingsSection } from "@multica/views/settings";
import { useT } from "@multica/views/i18n";
import type { TerminalCliErrorCode, TerminalCliStatus } from "../../../shared/terminal-cli";

export function TerminalCliSettings() {
  const { t } = useT("settings");
  const [status, setStatus] = useState<TerminalCliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TerminalCliErrorCode | "check_failed" | null>(null);
  const [changed, setChanged] = useState(false);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { setStatus(await window.desktopAPI.terminalCli.status()); }
    catch { setError("check_failed"); }
    finally { pending.current = false; setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const update = async (action: "install" | "uninstall") => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await window.desktopAPI.terminalCli[action]();
      if (result.ok) { setStatus(result.status); setChanged(action === "install"); }
      else {
        setError(result.error);
        setStatus(await window.desktopAPI.terminalCli.status());
      }
    } catch { setError("filesystem"); }
    finally { pending.current = false; setBusy(false); }
  };
  const errorMessage = () => {
    switch (error) {
      case "unsupported": return t(($) => $.desktop.terminal_cli.unsupported);
      case "bundle_missing": return status?.source.kind === "development" ? t(($) => $.desktop.terminal_cli.dev_bundle_missing) : t(($) => $.desktop.terminal_cli.bundle_missing);
      case "conflict": return t(($) => $.desktop.terminal_cli.conflict);
      case "shell_conflict": return t(($) => $.desktop.terminal_cli.shell_conflict);
      case "check_failed": return t(($) => $.desktop.terminal_cli.check_failed);
      default: return t(($) => $.desktop.terminal_cli.filesystem_error);
    }
  };
  const versionMessage = () => {
    if (!status) return t(($) => $.desktop.terminal_cli.checking);
    if (status.conflictPath) return t(($) => $.desktop.terminal_cli.conflict);
    if (!status.supported) return t(($) => $.desktop.terminal_cli.unsupported);
    if (!status.bundleAvailable) return status.source.kind === "development"
      ? t(($) => $.desktop.terminal_cli.dev_bundle_missing)
      : t(($) => $.desktop.terminal_cli.bundle_missing);
    if (status.bindingState === "other") return t(($) => $.desktop.terminal_cli.other_instance);
    switch (status.versionState) {
      case "current": return status.source.kind === "development" && status.bindingState === "current" ? t(($) => $.desktop.terminal_cli.dev_bound) : t(($) => $.desktop.terminal_cli.latest);
      case "update_available": return t(($) => $.desktop.terminal_cli.update_available);
      case "different": return t(($) => $.desktop.terminal_cli.different_version);
      case "newer": return t(($) => $.desktop.terminal_cli.newer_version);
      case "unknown": return t(($) => $.desktop.terminal_cli.version_unknown);
      default: return t(($) => $.desktop.terminal_cli.not_installed);
    }
  };
  const installLabel = status?.source.kind === "development"
    ? status.bindingState === "other" ? t(($) => $.desktop.terminal_cli.bind_dev) : t(($) => $.desktop.terminal_cli.install_dev)
    : status?.bindingState === "other" ? t(($) => $.desktop.terminal_cli.bind_app)
    : status?.versionState === "update_available"
    ? t(($) => $.desktop.terminal_cli.update)
    : status?.detectedPath && status.versionState !== "current"
      ? t(($) => $.desktop.terminal_cli.install_matching)
      : t(($) => $.desktop.terminal_cli.install);
  const showInstall = !status?.installed || status.versionState !== "current";
  const formatVersion = (value: TerminalCliStatus["currentVersion"]) => value
    ? `${value.version}${value.commit ? ` (${value.commit})` : ""}`
    : t(($) => $.desktop.terminal_cli.not_detected);
  return (
    <SettingsSection title={t(($) => $.desktop.terminal_cli.title)}>
      <SettingsCard>
        <SettingsRow label="Multica CLI" align="start" size="none" description={
          <div className="space-y-2">
            <p>{status?.source.kind === "development" ? t(($) => $.desktop.terminal_cli.dev_description) : t(($) => $.desktop.terminal_cli.description)}</p>
            {status && <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt>{t(($) => $.desktop.terminal_cli.source_label)}</dt><dd className="min-w-0 break-all">{status.source.kind === "development" ? t(($) => $.desktop.terminal_cli.dev_source) : t(($) => $.desktop.terminal_cli.packaged_source)}<code className="block text-caption">{status.source.cliPath}</code></dd>
                <dt>{t(($) => $.desktop.terminal_cli.current_version)}</dt><dd className="break-all font-mono">{formatVersion(status.currentVersion)}</dd>
                <dt>{t(($) => $.desktop.terminal_cli.bundled_version)}</dt><dd className="break-all font-mono">{formatVersion(status.bundledVersion)}</dd>
              </dl>
              <code className="block break-all text-caption">{status.conflictPath ?? status.detectedPath ?? status.commandPath}</code>
              {!status.managed && status.detectedPath && !status.conflictPath && <p>{t(($) => $.desktop.terminal_cli.preserve_external)}</p>}
              {!status.installed && !status.conflictPath && status.supported && <p className="break-words">{t(($) => $.desktop.terminal_cli.shell_changes, { files: status.shellFiles.join(", ") })}</p>}
            </>}
            <p role="status" aria-live="polite">{busy ? t(($) => $.desktop.terminal_cli.checking) : error === "check_failed" ? null : versionMessage()}</p>
            {changed && <p role="status">{t(($) => $.desktop.terminal_cli.reopen_terminal)}</p>}
            {error && <p role="alert" className="text-destructive">{errorMessage()}</p>}
          </div>
        }>
          <div className="flex flex-wrap items-center justify-end gap-2" aria-busy={busy}>
            {status?.managed && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void update("uninstall")}>{t(($) => $.desktop.terminal_cli.uninstall)}</Button>}
            {showInstall && <Button variant="outline" size="sm" disabled={busy || !status?.supported || !status.bundleAvailable || !!status.conflictPath} onClick={() => void update("install")}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
              {installLabel}
            </Button>}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              {t(($) => $.desktop.terminal_cli.check_version)}
            </Button>
          </div>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
