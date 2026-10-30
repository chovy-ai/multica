import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { parseWithFallback } from "@multica/core/api/schema";
import { Button } from "@multica/ui/components/ui/button";
import { Switch } from "@multica/ui/components/ui/switch";
import { Input } from "@multica/ui/components/ui/input";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multica/ui/components/ui/alert-dialog";
import { SettingsCard, SettingsRow } from "@multica/views/settings";
import { useT } from "@multica/views/i18n";
import { localV2Transport } from "../platform/local-v2-transport";

const policySchema = z.object({ enabled: z.boolean(), available: z.boolean(), ports: z.array(z.number().int().min(1).max(65535)).max(64), agent_ports: z.array(z.number().int().min(1).max(65535)).max(64).default([]) });
const key = ["service-preview", "policy"] as const;
const off = { enabled: false, available: false, ports: [] as number[], agent_ports: [] as number[] };

export function ServicePreviewSettings() {
  const { t } = useT("settings"), qc = useQueryClient();
  const policy = useQuery({ queryKey: key, queryFn: async () => parseWithFallback(await localV2Transport().servicePreview(), policySchema, off, { endpoint: "local.service-preview" }), retry: false, refetchInterval: 5000 });
  const [enabled, setEnabled] = useState(false), [ports, setPorts] = useState(""), [invalid, setInvalid] = useState(false);
  const [confirmation, setConfirmation] = useState<{ enabled: boolean; ports: number[] } | null>(null);
  const manualEnabled = policy.data?.enabled, manualPorts = policy.data?.ports;
  useEffect(() => { if (manualEnabled !== undefined && manualPorts) { setEnabled(manualEnabled); setPorts(manualPorts.join(", ")); } }, [manualEnabled, manualPorts]);
  useEffect(() => window.daemonAPI?.onStatusChange((status) => { if (status.state === "running") void qc.invalidateQueries({ queryKey: key }); }), [qc]);
  const save = useMutation({ mutationFn: async (value: { enabled: boolean; ports: number[] }) => {
    const result = parseWithFallback(await localV2Transport().setServicePreview(value), policySchema, null, { endpoint: "local.service-preview" });
    if (!result) throw new Error("Invalid service sharing response"); return result;
  }, onSuccess: (value) => { qc.setQueryData(key, value); setConfirmation(null); } });
  const revoke = useMutation({ mutationFn: async () => {
    const result = parseWithFallback(await localV2Transport().clearAgentServicePreviews(), policySchema, null, { endpoint: "local.service-preview" });
    if (!result) throw new Error("Invalid service sharing response"); return result;
  }, onSuccess: (value) => { qc.setQueryData(key, value); } });
  const submit = () => {
    const parts = ports.split(/[,，\s]+/).filter(Boolean), values = [...new Set(parts.map(Number))].sort((a, b) => a - b);
    if ((enabled && !values.length) || parts.some((value) => !/^\d+$/.test(value)) || values.length > 64 || values.some((port) => port < 1 || port > 65535)) { setInvalid(true); return; }
    setInvalid(false); save.reset(); const next = { enabled, ports: values };
    if (enabled && (!policy.data?.enabled || values.some((port) => !policy.data?.ports.includes(port)))) setConfirmation(next); else save.mutate(next);
  };
  const copy = t(($) => $.desktop.service_preview.title);
  return <SettingsCard>
    <SettingsRow label={copy} description={t(($) => $.desktop.service_preview.description)}>
      <Switch aria-label={t(($) => $.desktop.service_preview.allow)} checked={enabled} disabled={!policy.data?.available || save.isPending} onCheckedChange={setEnabled} />
    </SettingsRow>
    <SettingsRow label={t(($) => $.desktop.service_preview.ports)}>
      <Input aria-label={t(($) => $.desktop.service_preview.ports)} value={ports} onChange={(event) => { setPorts(event.target.value); setInvalid(false); }} placeholder="3000, 5173" disabled={save.isPending} className="max-w-64" />
    </SettingsRow>
    {Boolean(policy.data?.agent_ports.length) && <SettingsRow label={t(($) => $.desktop.service_preview.agent_ports)} description={policy.data!.agent_ports.join(", ")}>
      <Button variant="outline" size="sm" disabled={revoke.isPending || save.isPending} onClick={() => { revoke.mutate(); }}>{t(($) => $.desktop.service_preview.revoke_agent_ports)}</Button>
    </SettingsRow>}
    {(invalid || save.isError || policy.isError || revoke.isError) && <p role="alert" className="px-4 pb-3 text-caption text-destructive">{invalid ? t(($) => $.desktop.service_preview.invalid_ports) : t(($) => $.desktop.service_preview.failed)}</p>}
    <div className="flex justify-end px-4 pb-4"><Button disabled={!policy.data?.available || save.isPending} aria-busy={save.isPending} onClick={submit}>{t(($) => $.desktop.service_preview.save)}</Button></div>
    <AlertDialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open && !save.isPending) setConfirmation(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t(($) => $.desktop.service_preview.confirm_title)}</AlertDialogTitle><AlertDialogDescription>{t(($) => $.desktop.service_preview.confirm_description, { ports: confirmation?.ports.join(", ") ?? "" })}</AlertDialogDescription></AlertDialogHeader>
      {save.isError && <p role="alert" className="text-caption text-destructive">{t(($) => $.desktop.service_preview.failed)}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={save.isPending}>{t(($) => $.desktop.device_link.cancel)}</AlertDialogCancel><Button disabled={save.isPending} onClick={() => { if (confirmation) save.mutate(confirmation); }}>{t(($) => $.desktop.device_link.confirm)}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </SettingsCard>;
}
