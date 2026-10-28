import { JsonRpcPeer } from "./json-rpc";
import { createSidecarHost } from "./sidecar-host";

// The daemon runs this file with Electron in Node mode and speaks
// newline-delimited JSON-RPC on stdio. Logs must go to stderr: stdout is the
// protocol channel.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

let exiting = false;
const exit = (code: number) => { if (!exiting) { exiting = true; process.exit(code); } };
const host = createSidecarHost(() => peer, { onShutdown: () => exit(0) });
const peer: JsonRpcPeer = new JsonRpcPeer(process.stdin, process.stdout, (method, params) => host.handle(method, params));

// stdin closing means the daemon is gone, even if it was killed without a
// shutdown request: persist and leave instead of running unsupervised.
void peer.closed.then(async () => {
  try { await host.stop(); } finally { exit(0); }
});
