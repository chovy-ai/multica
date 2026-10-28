import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import type { LocalConversationScope } from "@multica/core/local-conversation/protocol";
import type { ChromeProfileImportResult } from "../../../shared/resource-preview";

function failureMessage(code: string | undefined, chinese: boolean): string {
  switch (code) {
    case "unsupported-platform": return chinese ? "目前仅支持 macOS 上的 Chrome Stable。" : "Currently available for Chrome Stable on macOS only.";
    case "busy": return chinese ? "此工作区已有导入正在进行，请稍后重试。" : "An import is already running in this workspace. Try again shortly.";
    case "keychain_denied": return chinese ? "钥匙串访问被拒绝。请重试，并允许访问 Chrome Safe Storage。" : "Keychain access was denied. Retry and allow access to Chrome Safe Storage.";
    case "keychain_timeout": return chinese ? "钥匙串授权超时，请重试。" : "Keychain authorization timed out. Try again.";
    case "snapshot_failed": return chinese ? "无法读取 Chrome Cookie。请退出 Chrome 后重试。" : "Could not read Chrome cookies. Quit Chrome and try again.";
    case "profile-not-found": return chinese ? "此 Chrome 配置已不可用，请重新打开并选择。" : "This Chrome profile is no longer available. Reopen and choose a profile.";
    case "invalid-target": return chinese ? "请先打开 Side 网页，再重试导入。" : "Open a Side webpage before importing.";
    case "schema_unsupported":
    case "cipher_incompatible":
    case "integrity_failed": return chinese ? "此 Chrome Cookie 格式暂不支持。" : "This Chrome cookie format is not supported.";
    default: return chinese ? "导入失败，请重试。" : "Import failed. Try again.";
  }
}

function importMessage(value: ChromeProfileImportResult, chinese: boolean): string {
  if (value.status === "canceled") return chinese ? "已取消导入，未写入 Cookie。" : "Import canceled. No cookies were written.";
  if (value.status === "failed") return failureMessage(value.code, chinese);
  if (value.status === "empty") return chinese ? `没有可导入的 Cookie（跳过 ${value.skipped} 项）。` : `No cookies to import (${value.skipped} skipped).`;
  const counts = chinese ? `已导入 ${value.imported} 项 Cookie，跳过 ${value.skipped} 项，失败 ${value.failed} 项。` : `Imported ${value.imported} cookies; ${value.skipped} skipped; ${value.failed} failed.`;
  if (value.code === "flush-failed") return counts + (chinese ? " 写入磁盘失败，重启后可能丢失，请重试。" : " Saving to disk failed; cookies may be lost after restart. Try again.");
  return (value.status === "partial" ? (chinese ? "部分导入成功。" : "Partially imported. ") : "") + counts;
}

export function ChromeProfileImport({ scope, previewId, chinese }: { scope: LocalConversationScope; previewId: string; chinese: boolean }) {
  const client = window.desktopAPI.resourcePreview;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [canceling, setCanceling] = useState(false);
  const receipt = useRef<string | null>(null);
  const profiles = useQuery({
    queryKey: ["side-chrome-profiles", scope.userId, scope.workspaceId],
    queryFn: () => client.listChromeProfiles(scope),
    enabled: open,
    retry: false,
  });
  const operation = useMutation({
    mutationFn: (input: { profileId: string; requestId: string }) => client.importChromeProfile(scope, { ...input, id: previewId }),
    onSettled: () => { receipt.current = null; setCanceling(false); setNotice(""); },
  });
  useEffect(() => () => {
    if (receipt.current) void client.cancelChromeProfileImport(scope, receipt.current).catch(() => {});
  }, [client, scope]);
  const available = profiles.data?.status === "available" ? profiles.data.profiles : [];
  const profileId = available.some((profile) => profile.id === selected) ? selected : available[0]?.id;
  const cancel = async () => {
    const requestId = receipt.current;
    if (!requestId || canceling) return;
    try {
      const accepted = await client.cancelChromeProfileImport(scope, requestId);
      if (receipt.current !== requestId) return;
      setCanceling(accepted);
      setNotice(accepted ? (chinese ? "正在取消…" : "Canceling…") : (chinese ? "正在完成写入，请稍候…" : "Finishing the import. Please wait…"));
    } catch { setNotice(chinese ? "无法取消，请等待导入结果。" : "Could not cancel. Please wait for the import result."); }
  };
  const changeOpen = (value: boolean) => {
    if (!value && receipt.current) { void cancel(); return; }
    if (value) { operation.reset(); setNotice(""); }
    setOpen(value);
  };

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger render={<Button variant="ghost" size="sm" aria-label={chinese ? "导入 Chrome 配置" : "Import Chrome profile"} />}><Download className="size-4" />{chinese ? "导入 Chrome" : "Import Chrome"}</DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{chinese ? "导入 Chrome 配置" : "Import Chrome profile"}</DialogTitle>
        <DialogDescription>{chinese ? "仅导入 Cookie 到当前工作区的 Side 网页，同名 Cookie 将被覆盖。macOS 可能请求钥匙串授权；不包含书签、密码或扩展，部分网站仍需重新登录。" : "Import cookies into this workspace’s Side webpages, replacing matching cookies. macOS may request Keychain access. Bookmarks, passwords and extensions are excluded; some sites may require signing in again."}</DialogDescription>
      </DialogHeader>
      {profiles.isPending ? <p role="status" className="flex items-center gap-2 text-body"><Loader2 className="size-4 animate-spin" />{chinese ? "正在查找 Chrome 配置…" : "Finding Chrome profiles…"}</p> : profiles.isError ? <div role="alert"><p>{chinese ? "无法读取 Chrome 配置。" : "Could not read Chrome profiles."}</p><Button variant="outline" size="sm" onClick={() => { void profiles.refetch(); }}>{chinese ? "重试" : "Retry"}</Button></div> : profiles.data?.status === "unavailable" ? <div role="status" className="text-body text-muted-foreground">
        <p>{profiles.data.reason === "unsupported-platform" ? failureMessage("unsupported-platform", chinese) : profiles.data.reason === "no-profiles" ? (chinese ? "未找到标准路径下的 Chrome 配置。请先打开 Chrome 创建配置，然后重试。" : "No Chrome profiles were found in the standard location. Open Chrome to create a profile, then retry.") : (chinese ? "无法读取 Chrome 配置，请重试。" : "Could not read Chrome profiles. Try again.")}</p>
        {profiles.data.reason !== "unsupported-platform" && <Button variant="outline" size="sm" onClick={() => { void profiles.refetch(); }}>{chinese ? "重试" : "Retry"}</Button>}
      </div> : <fieldset disabled={operation.isPending} className="min-w-0 max-h-64 space-y-2 overflow-auto">
        <legend className="mb-2 text-label">{chinese ? "选择 Chrome 配置" : "Choose a Chrome profile"}</legend>
        {available.map((profile) => <label key={profile.id} className={`flex min-w-0 cursor-pointer items-center gap-3 rounded-md p-2 ${profileId === profile.id ? "bg-surface-selected hover:bg-surface-selected" : "hover:bg-surface-hover"}`}>
          <input type="radio" name={`chrome-profile-${previewId}`} value={profile.id} checked={profileId === profile.id} onChange={() => { setSelected(profile.id); operation.reset(); }} />
          <span className="min-w-0 flex-1"><span className="block truncate text-label" title={profile.name}>{profile.name}</span>{profile.email && <> <span className="block truncate text-caption text-muted-foreground" title={profile.email}>{profile.email}</span></>}</span>
        </label>)}
      </fieldset>}
      {operation.isPending && <p role="status" className="flex items-center gap-2 text-body"><Loader2 className="size-4 animate-spin" />{notice || (chinese ? "正在导入，请留意系统授权提示…" : "Importing. Check for a system authorization prompt…")}</p>}
      {operation.isError && <p role="alert" className="text-body">{failureMessage(undefined, chinese)}</p>}
      {operation.data && <p role={operation.data.status === "failed" || operation.data.status === "partial" ? "alert" : "status"} className="text-body">{importMessage(operation.data, chinese)}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={canceling} onClick={() => { if (receipt.current) void cancel(); else setOpen(false); }}>{operation.isPending ? (chinese ? "取消导入" : "Cancel import") : (chinese ? "关闭" : "Close")}</Button>
        <Button disabled={!profileId || profiles.isFetching || operation.isPending} aria-busy={operation.isPending} onClick={() => {
          if (!profileId || receipt.current) return;
          const requestId = crypto.randomUUID();
          receipt.current = requestId;
          operation.mutate({ profileId, requestId });
        }}>{operation.isPending && <Loader2 className="size-4 animate-spin" />}{chinese ? "导入" : "Import"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
