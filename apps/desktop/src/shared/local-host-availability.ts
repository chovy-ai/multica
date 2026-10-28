import type { SidecarStatus } from "@multica/core/local-conversation/wire";

/** Whether Desktop can reach the daemon-hosted local conversation service. */
export type LocalHostAvailability =
  | { state: "connected"; sidecar: SidecarStatus }
  | { state: "unavailable"; reason: "daemon_offline" | "unsupported" | "not_signed_in" | "account_mismatch" | "incompatible" };

/** The notice for a state that blocks or delays local conversations; null when they work. */
export function localHostAvailabilityMessage(value: LocalHostAvailability | null, chinese: boolean): string | null {
  if (!value) return null;
  if (value.state === "connected") {
    if (value.sidecar === "crashed") return chinese ? "本机会话服务异常退出，正在重新启动。" : "The local conversation service stopped unexpectedly and is restarting.";
    if (value.sidecar === "draining") return chinese ? "本机会话服务正在更新，稍后可继续发送。" : "The local conversation service is updating. You can send again shortly.";
    return null;
  }
  switch (value.reason) {
    case "daemon_offline": return chinese ? "本机守护进程未运行，启动后即可使用本机会话。" : "Start the local daemon to use local conversations.";
    case "not_signed_in": return chinese ? "登录 Multica 后即可使用本机会话。" : "Sign in to Multica to use local conversations.";
    case "account_mismatch": return chinese ? "本机守护进程正被其他账号使用，本机会话暂不可用。" : "The local daemon is in use by another account, so local conversations are unavailable.";
    case "unsupported": return chinese ? "本机会话需要 Multica 桌面端自带的守护进程，WSL 或单独安装的 CLI 不支持。" : "Local conversations need the daemon bundled with Multica Desktop. WSL and separately installed CLIs are not supported.";
    case "incompatible": return chinese ? "请更新 Multica，使桌面端与本机守护进程版本一致。" : "Update Multica so Desktop and the local daemon match.";
  }
}
