/**
 * Variables provider CLIs need to be found and to reach their services. The
 * sidecar adopts them instead of whatever environment launched the daemon.
 * Credentials and Electron settings are deliberately not forwarded.
 */
const FORWARDED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TMPDIR|TEMP|TMP|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_[A-Z_]+|APPDATA|LOCALAPPDATA|USERPROFILE|SYSTEMROOT|COMSPEC|PATHEXT|(?:HTTPS?|ALL|NO)_PROXY|(?:https?|all|no)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;

export function localProviderEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => FORWARDED.test(entry[0]) && typeof entry[1] === "string"));
}
