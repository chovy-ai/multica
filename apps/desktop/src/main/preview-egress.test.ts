// @vitest-environment node
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));
vi.mock("node:dns/promises", () => ({ lookup: fake.lookup }));
import { connectPreviewEgress, publicPreviewAddress } from "./preview-egress";
afterEach(() => { fake.lookup.mockReset(); fake.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]); });
it("rejects private, link-local, CGNAT and IPv4-mapped destinations before opening an egress connection", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) expect(publicPreviewAddress(address), address).toBe(false);
  expect(publicPreviewAddress("8.8.8.8")).toBe(true); expect(publicPreviewAddress("2606:4700::1111")).toBe(true);
  fake.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]); const resolve = vi.fn();
  await expect(connectPreviewEgress({ host: "public-looking.test", port: 80, url: "http://public-looking.test/" }, new AbortController().signal, resolve)).rejects.toThrow("preview_destination_denied"); expect(resolve).not.toHaveBeenCalled();
});
it("uses a system HTTP proxy while pinning its destination IP and preserving buffered tunnel bytes", async () => {
  const server = http.createServer(); let authority = "";
  server.on("connect", (request, socket) => { authority = request.url!; socket.write("HTTP/1.1 200 Connection Established\r\n\r\nREADY"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address() as net.AddressInfo;
  const controller = new AbortController();
  try {
    const stream = await connectPreviewEgress({ host: "example.test", port: 443, url: "https://example.test/" }, controller.signal, async () => `PROXY 127.0.0.1:${address.port}`);
    expect(authority).toBe("8.8.8.8:443"); stream.resume(); const [data] = await once(stream, "data"); expect(data.toString()).toBe("READY"); stream.destroy();
  } finally { controller.abort(); server.closeAllConnections(); server.close(); }
});

it.each(["SOCKS4", "SOCKS5"])("uses the system %s proxy with a pinned destination and buffered response", async (kind) => {
  let received = Buffer.alloc(0), greeted = kind === "SOCKS4";
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("data", (data: Buffer) => {
      if (!greeted) { expect(data).toEqual(Buffer.from([5, 1, 0])); greeted = true; socket.write(Buffer.from([5, 0])); return; }
      received = Buffer.from(data);
      socket.write(Buffer.concat([kind === "SOCKS4" ? Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]) : Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from("READY")]));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address() as net.AddressInfo;
  const controller = new AbortController();
  try {
    const stream = await connectPreviewEgress({ host: "example.test", port: 443, url: "https://example.test/" }, controller.signal, async () => `${kind} 127.0.0.1:${address.port}`);
    expect(received).toEqual(kind === "SOCKS4" ? Buffer.from([4, 1, 1, 187, 8, 8, 8, 8, 0]) : Buffer.from([5, 1, 0, 1, 8, 8, 8, 8, 1, 187]));
    const response = once(stream, "data"); stream.resume(); expect((await response)[0].toString()).toBe("READY"); stream.destroy();
  } finally { controller.abort(); for (const socket of sockets) socket.destroy(); server.close(); }
});
