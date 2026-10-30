// Isolated Chromium regression: actual localhost routing, proxy auth, WS and device partitions.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "@playwright/test";
import ts from "typescript";

const root = process.cwd(), temporary = await mkdtemp(join(tmpdir(), "multica-preview-proxy-"));
const requireDesktop = createRequire(join(root, "apps/desktop/package.json"));
const { WebSocketServer } = requireDesktop("ws");
const servers = [], proxies = [];
let application, trapHits = 0;
try {
  const source = await readFile(join(root, "apps/desktop/src/main/preview-proxy.ts"), "utf8");
  const modulePath = join(temporary, "proxy.mjs");
  await writeFile(modulePath, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const { createPreviewProxy } = await import(pathToFileURL(modulePath).href);
  const listen = async (server) => { servers.push(server); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; };
  const trapPort = await listen(http.createServer((_request, response) => { trapHits++; response.end("LOCAL"); }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(temporary, "key.pem"), "-out", join(temporary, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const securePort = await listen(https.createServer({ key: await readFile(join(temporary, "key.pem")), cert: await readFile(join(temporary, "cert.pem")) }, (_request, response) => response.end("SECURE REMOTE")));
  const startRemote = async (name) => {
    const server = http.createServer((request, response) => {
      if (request.url === "/api") { response.end(name); return; }
      response.setHeader("Content-Type", "text/html");
      response.end(`<body data-source="${name}"><script>
        fetch('/api').then(r=>r.text()).then(v=>document.body.dataset.api=v);
        const ws=new WebSocket('ws://localhost:${trapPort}/ws');ws.onopen=()=>ws.send('ping');ws.onmessage=e=>document.body.dataset.ws=e.data;
      </script>`);
    });
    const ws = new WebSocketServer({ server }); ws.on("connection", (socket) => socket.on("message", () => socket.send(name)));
    return listen(server);
  };
  for (const name of ["REMOTE-A", "REMOTE-B"]) {
    const port = await startRemote(name);
    proxies.push(await createPreviewProxy({ connect: (target, signal) => new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: target.port === securePort ? securePort : port, signal }); socket.once("connect", () => resolve(socket)); socket.once("error", reject);
    }) }));
  }
  const mainPath = join(temporary, "main.cjs");
  await writeFile(mainPath, `const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(join(temporary, "profile"))});
    const configs=${JSON.stringify(proxies.map(({ address, username, password }) => ({ address, username, password })))};
    const contexts=new Map();
    app.on('login',(event,contents,_details,info,callback)=>{const config=contents&&contexts.get(contents.session);if(info.isProxy&&config&&info.host==='127.0.0.1'&&String(info.port)===config.address.split(':')[1]){event.preventDefault();callback(config.username,config.password);}});
    app.whenReady().then(async()=>{for(let i=0;i<configs.length;i++){const config=configs[i],ses=session.fromPartition('device-'+i);contexts.set(ses,config);ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);await ses.setProxy({mode:'fixed_servers',proxyRules:'http://'+config.address,proxyBypassRules:'<-loopback>'});const win=new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');await win.loadURL('http://localhost:${trapPort}/');}});`);
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  application = await electron.launch({ executablePath: requireDesktop("electron"), args: [mainPath], env });
  for (const [index, name] of ["REMOTE-A", "REMOTE-B"].entries()) {
    if (application.windows().length <= index) await application.waitForEvent("window", { predicate: async () => application.windows().length > index });
    const page = application.windows()[index];
    await page.waitForFunction((name) => document.body?.dataset.source === name && document.body.dataset.api === name && document.body.dataset.ws === name, name, { timeout: 20_000 }).catch(async (error) => {
      console.error("Browser routing fixture:", index, await page.evaluate(() => ({ url: location.href, body: document.body?.outerHTML })));
      throw error;
    });
    await page.evaluate((name) => { document.cookie = `device=${name}; path=/`; }, name);
  }
  assert.match(await application.windows()[0].evaluate(() => document.cookie), /device=REMOTE-A/);
  assert.match(await application.windows()[1].evaluate(() => document.cookie), /device=REMOTE-B/);
  await application.windows()[0].reload();
  assert.equal(await application.windows()[0].locator("body").getAttribute("data-source"), "REMOTE-A");
  const certificateError = await application.evaluate(async ({ BrowserWindow }, url) => {
    const probe = new BrowserWindow({ show: false, webPreferences: { session: BrowserWindow.getAllWindows()[0].webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await probe.loadURL(url); return ""; } catch (error) { return error.message; } finally { probe.destroy(); }
  }, `https://localhost:${securePort}/`);
  assert.match(certificateError, /ERR_CERT_AUTHORITY_INVALID/);
  // Killing one route must never expose this machine's same-origin localhost service.
  proxies[0].close();
  await assert.rejects(application.windows()[0].reload());
  assert.equal(trapHits, 0, "Remote preview must never reach this machine's same-origin trap");
  console.log("PASS: fixed localhost proxy, authentication, HTTP/fetch, WebSocket, reload, HTTPS certificate verification, denied webpage permissions, device Cookie isolation and proxy failure without local fallback");
} finally {
  await application?.close(); for (const proxy of proxies) proxy.close();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  await rm(temporary, { recursive: true, force: true });
}
