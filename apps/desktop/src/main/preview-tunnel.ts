import { Duplex } from "node:stream";
import WebSocket from "ws";

/** The native process's authenticated local bridge; tokens never enter a webpage URL. */
export async function openPreviewTunnel(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Duplex> {
  const socket = new WebSocket(url, { headers, handshakeTimeout: 20_000, maxPayload: 64 << 10 });
  const cancel = () => socket.terminate(); signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve); socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => { let bytes = 0, body = ""; response.on("data", (data: Buffer) => { bytes += data.length; if (bytes <= 4096) body += data.toString(); else response.destroy(); }); response.on("end", () => { try { const value = JSON.parse(body); reject(new Error(`${value.error?.kind ?? "preview_proxy_unavailable"}: ${value.error?.message ?? "Service preview failed"}`)); } catch { reject(new Error("preview_proxy_unavailable: Service preview failed")); } socket.terminate(); }); response.on("error", reject); });
      if (signal.aborted) { socket.terminate(); reject(new Error("Preview connection canceled")); }
    });
    if (signal.aborted) throw new Error("Preview connection canceled");
  } catch (error) { socket.terminate(); throw error; }
  finally { signal.removeEventListener("abort", cancel); }
  let sentEOF = false, receivedEOF = false;
  const finish = () => { if (sentEOF && receivedEOF) socket.close(); };
  const stream = new Duplex({ allowHalfOpen: true,
    read() { socket.resume(); },
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0; const next = (error?: Error | null) => { if (error) { callback(error); return; } if (offset >= chunk.length) { callback(); return; } const data = chunk.subarray(offset, offset + (64 << 10)); offset += data.length; socket.send(data, { binary: true }, next); }; next();
    },
    final(callback) { sentEOF = true; socket.send('{"type":"half_close"}', (error) => { callback(error); finish(); }); },
    destroy(error, callback) { socket.terminate(); callback(error); },
  });
  socket.on("message", (raw, binary) => {
    if (binary && !receivedEOF) { if (!stream.push(raw)) socket.pause(); return; }
    if (!binary && !receivedEOF && raw.toString() === '{"type":"half_close"}') { receivedEOF = true; stream.push(null); finish(); return; }
    stream.destroy(new Error("Invalid preview tunnel frame"));
  });
  socket.on("error", (error) => stream.destroy(error));
  socket.on("close", () => { if (!receivedEOF || !sentEOF) stream.destroy(new Error("device_unreachable: Preview tunnel disconnected")); });
  return stream;
}
