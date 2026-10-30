import net from "node:net";
import tls from "node:tls";
import { lookup } from "node:dns/promises";
import type { PreviewDialTarget } from "./preview-proxy";

/** Pin public DNS results before connecting, including through system proxies. */
export function publicPreviewAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  return net.isIP(address) === 6 && (Number.parseInt(address.split(":")[0]!, 16) & 0xe000) === 0x2000 && !address.toLowerCase().startsWith("2001:db8:");
}
const authority = (host: string, port: number) => `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
async function socket(host: string, port: number, signal: AbortSignal, secure = false): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const value = secure ? tls.connect({ socket: net.connect({ host, port, signal }), servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port, signal });
    value.once(secure ? "secureConnect" : "connect", () => resolve(value)); value.once("error", reject);
  });
}
async function read(socket: net.Socket, signal: AbortSignal, complete: (data: Buffer) => number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const cleanup = () => { socket.off("data", receive); socket.off("error", error); socket.off("end", end); signal.removeEventListener("abort", abort); };
    const error = (error: Error) => { cleanup(); reject(error); };
    const end = () => error(new Error("System proxy closed its connection"));
    const abort = () => { socket.destroy(); error(new Error("Preview connection canceled")); };
    const receive = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]); if (data.length > 32_768) { socket.destroy(); error(new Error("Invalid system proxy response")); return; }
      const size = complete(data); if (size < 0) return;
      socket.pause(); cleanup(); if (data.length > size) socket.unshift(data.subarray(size)); resolve(data.subarray(0, size));
    };
    socket.on("data", receive); socket.once("error", error); socket.once("end", end); signal.addEventListener("abort", abort, { once: true }); socket.resume(); if (signal.aborted) abort();
  });
}
const exact = (socket: net.Socket, signal: AbortSignal, count: number) => read(socket, signal, (data) => data.length >= count ? count : -1);
function ipBytes(address: string): Buffer {
  if (net.isIP(address) === 4) return Buffer.from(address.split(".").map(Number));
  const [left, right] = address.split("::"); const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  const groups = [...a, ...Array(8 - a.length - b.length).fill("0"), ...b]; const bytes = Buffer.alloc(16); groups.forEach((group, i) => bytes.writeUInt16BE(Number.parseInt(group, 16), i * 2)); return bytes;
}

export async function connectPreviewEgress(target: PreviewDialTarget, signal: AbortSignal, resolveProxy: (url: string) => Promise<string>): Promise<net.Socket> {
  const addresses = net.isIP(target.host) ? [{ address: target.host }] : await lookup(target.host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !publicPreviewAddress(address))) throw new Error("preview_destination_denied: Only public resources can use this device's network");
  const routes = (await resolveProxy(target.url)).split(";").map((value) => value.trim()).filter(Boolean);
  let last: unknown;
  for (const route of routes) for (const { address } of addresses) {
    let value: net.Socket | undefined;
    try {
      if (signal.aborted) throw new Error("Preview connection canceled");
      if (route === "DIRECT") return await socket(address, target.port, signal);
      const [kind, endpoint] = route.split(/\s+/);
      if (!endpoint || !["PROXY", "HTTP", "HTTPS", "SOCKS", "SOCKS4", "SOCKS5"].includes(kind!)) throw new Error("Unsupported system proxy configuration");
      const proxy = new URL(`http://${endpoint}`); if (proxy.username || proxy.password || proxy.pathname !== "/") throw new Error("Invalid system proxy configuration");
      value = await socket(proxy.hostname.replace(/^\[|\]$/g, ""), Number(proxy.port || (kind === "HTTPS" ? 443 : 80)), signal, kind === "HTTPS");
      if (kind === "SOCKS5") {
        value.write(Buffer.from([5, 1, 0])); const greeting = await exact(value, signal, 2); if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error("System proxy requires unsupported authentication");
        const port = Buffer.alloc(2); port.writeUInt16BE(target.port); value.write(Buffer.concat([Buffer.from([5, 1, 0, net.isIP(address) === 4 ? 1 : 4]), ipBytes(address), port]));
        const head = await exact(value, signal, 4); if (head[0] !== 5 || head[1] !== 0) throw new Error("System SOCKS proxy refused the destination");
        const size = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await exact(value, signal, 1))[0]! : -1;
        if (size < 0) throw new Error("Invalid SOCKS proxy response"); await exact(value, signal, size + 2);
      } else if (kind === "SOCKS" || kind === "SOCKS4") {
        if (net.isIP(address) !== 4) throw new Error("SOCKS4 cannot connect to an IPv6 destination");
        const port = Buffer.alloc(2); port.writeUInt16BE(target.port); value.write(Buffer.concat([Buffer.from([4, 1]), port, ipBytes(address), Buffer.from([0])]));
        if ((await exact(value, signal, 8))[1] !== 90) throw new Error("System SOCKS proxy refused the destination");
      } else {
        const destination = authority(address, target.port); value.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`);
        const reply = await read(value, signal, (data) => { const end = data.indexOf("\r\n\r\n"); return end < 0 ? -1 : end + 4; });
        if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(reply.toString("latin1"))) throw new Error("System HTTP proxy refused the destination or requires authentication");
      }
      return value;
    } catch (error) { value?.destroy(); last = error; }
  }
  throw last instanceof Error ? last : new Error("No supported system proxy route is available");
}
