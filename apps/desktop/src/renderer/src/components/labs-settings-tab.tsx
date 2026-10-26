import { useRef, useState } from "react";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import { useAuthStore } from "@multica/core/auth";
import { useCurrentWorkspace } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { SettingsCard, SettingsRow, SettingsTab } from "@multica/views/settings";
import { useT } from "@multica/views/i18n";
import { toast } from "sonner";

export function LabsSettingsTab() {
  const { t } = useT("settings");
  const workspace = useCurrentWorkspace();
  const userId = useAuthStore((state) => state.user?.id);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const pending = useRef(false);
  const exportLogs = async () => {
    if (!workspace || !userId || pending.current) return;
    pending.current = true; setExporting(true); setSaved(null);
    try {
      const result = await window.desktopAPI.developerLogs.export({ userId, workspaceId: workspace.id });
      if (result.status === "saved") {
        setSaved(t(($) => $.labs.logs_saved, { filename: result.filename, count: result.recordCount }));
        toast.success(t(($) => $.labs.logs_exported));
      }
    } catch { toast.error(t(($) => $.labs.logs_failed)); }
    finally { pending.current = false; setExporting(false); }
  };
  return (
    <SettingsTab title={t(($) => $.page.tabs.labs)} scope="device-workspace">
      <SettingsCard>
        <SettingsRow label={t(($) => $.labs.logs_title)} align="start" description={
          <div className="space-y-2">
            <p>{t(($) => $.labs.logs_description)}</p>
            <p>{t(($) => $.labs.logs_privacy)}</p>
            {saved && <p role="status" className="break-all">{saved}</p>}
          </div>
        }>
          <Button variant="outline" size="sm" disabled={exporting || !workspace || !userId} aria-busy={exporting} onClick={() => void exportLogs()}>
            {exporting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
            {exporting ? t(($) => $.labs.logs_exporting) : t(($) => $.labs.logs_export)}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsTab>
  );
}
