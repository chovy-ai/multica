// The default registry and relay deployed by deploy-p2p.yml.
const DEFAULT_P2P_SERVER_URL = "http://101.33.221.22:8090";

// Runtime configuration wins over a build-time registry and the default.
// Sharing this device's conversations still requires the Device link switch.
export function p2pServerEnv(
  processEnv: NodeJS.ProcessEnv,
  buildUrl: string | undefined,
): NodeJS.ProcessEnv {
  if (processEnv.MULTICA_DAEMON_P2P_SERVER_URL?.trim()) return {};
  const url = buildUrl?.trim() || DEFAULT_P2P_SERVER_URL;
  return { MULTICA_DAEMON_P2P_SERVER_URL: url };
}

export function buildP2PServerUrl(): string | undefined {
  return (import.meta.env as { readonly VITE_P2P_SERVER_URL?: string }).VITE_P2P_SERVER_URL;
}
