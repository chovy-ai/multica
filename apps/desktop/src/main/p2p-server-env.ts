// The p2p device registry the Desktop-managed daemon links devices through.
// Builds bake it in with VITE_P2P_SERVER_URL; without it device links stay
// off. A MULTICA_DAEMON_P2P_SERVER_URL already in the environment wins so a
// developer can point one machine at a test registry.
export function p2pServerEnv(
  processEnv: NodeJS.ProcessEnv,
  buildUrl: string | undefined,
): NodeJS.ProcessEnv {
  if (processEnv.MULTICA_DAEMON_P2P_SERVER_URL?.trim()) return {};
  const url = buildUrl?.trim();
  return url ? { MULTICA_DAEMON_P2P_SERVER_URL: url } : {};
}

export function buildP2PServerUrl(): string | undefined {
  return (import.meta.env as { readonly VITE_P2P_SERVER_URL?: string }).VITE_P2P_SERVER_URL;
}
