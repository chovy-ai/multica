/** Whether Desktop can reach the daemon's local conversation service. */
export type LocalHostAvailability =
  | { state: "connected" }
  /** The daemon waits for running turns to end before it restarts. */
  | { state: "updating" }
  | { state: "unavailable"; reason: LocalHostUnavailableReason };

export type LocalHostUnavailableReason = "daemon_offline" | "unsupported" | "not_signed_in" | "account_mismatch" | "incompatible"
  // Another device over Device link.
  | "device_unreachable" | "device_link_off" | "device_unknown" | "api_url_mismatch";

/**
 * The notice for a state that blocks or delays local conversations; null
 * when they work. device names another device reached over Device link.
 */
export function localHostAvailabilityMessage(value: LocalHostAvailability | null, chinese: boolean, device?: string): string | null {
  if (!value) return null;
  if (value.state === "connected") return null;
  if (device !== undefined) {
    if (value.state === "updating") return chinese ? `${device} 正在更新，稍后可继续发送。` : `${device} is updating. You can send again shortly.`;
    switch (value.reason) {
      case "device_unreachable":
      case "device_unknown": return chinese ? `与 ${device} 的连接已断开，正在重连` : `Lost connection to ${device}. Reconnecting…`;
      case "device_link_off": return chinese ? `${device} 已关闭设备互联` : `${device} turned off Device link`;
      case "api_url_mismatch": return chinese ? `${device} 连接的是另一个 Multica 服务端` : `${device} is connected to a different Multica server`;
      case "incompatible": return chinese ? "两台设备的 Multica 版本不一致，更新后再试" : "Update Multica on both devices to the same version";
      case "account_mismatch":
      case "not_signed_in": return chinese ? `${device} 未登录这个账号` : `${device} is not signed in to this account`;
    }
  }
  if (value.state === "updating") return chinese ? "本机会话服务正在更新，稍后可继续发送。" : "The local conversation service is updating. You can send again shortly.";
  switch (value.reason) {
    case "daemon_offline": return chinese ? "本机守护进程未运行，启动后即可使用本机会话。" : "Start the local daemon to use local conversations.";
    case "not_signed_in": return chinese ? "登录 Multica 后即可使用本机会话。" : "Sign in to Multica to use local conversations.";
    case "account_mismatch": return chinese ? "本机守护进程正被其他账号使用，本机会话暂不可用。" : "The local daemon is in use by another account, so local conversations are unavailable.";
    case "unsupported": return chinese ? "本机会话需要 Multica 桌面端自带的守护进程，WSL 或单独安装的 CLI 不支持。" : "Local conversations need the daemon bundled with Multica Desktop. WSL and separately installed CLIs are not supported.";
    case "incompatible": return chinese ? "请更新 Multica，使桌面端与本机守护进程版本一致。" : "Update Multica so Desktop and the local daemon match.";
    case "device_unreachable":
    case "device_link_off":
    case "device_unknown":
    case "api_url_mismatch": return null;
  }
}
