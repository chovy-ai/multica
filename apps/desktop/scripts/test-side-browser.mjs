import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Runs an isolated Electron fixture; it never starts Multica or an installed provider.
const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const output = resolve(directory, ".tmp/side-browser");
await mkdir(output, { recursive: true });
const fixtureHtml = `<!doctype html><html><body><label>Query<input id="query" aria-label="Query"></label><button onclick="document.getElementById('result').textContent=document.getElementById('query').value">Search</button><select aria-label="Category" id="category"><option value="a">A</option><option value="b">B</option></select><p id="result"></p><div style="height:2000px">Fixture</div></body></html>`;
const entry = `
import { app, BrowserWindow, WebContentsView } from "electron";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { SideBrowserController } from "./side-browser-controller";
app.setPath("userData", ${JSON.stringify(resolve(output, "profile"))});
app.commandLine.appendSwitch("no-proxy-server");
app.whenReady().then(async () => {
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(${JSON.stringify(fixtureHtml)}); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const window = new BrowserWindow({ width: 900, height: 650, show: false, webPreferences: { offscreen: true } });
const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
await view.webContents.loadURL('http://127.0.0.1:' + server.address().port);
view.setVisible(true);
const activity = [];
const controller = new SideBrowserController((...values) => activity.push(values));
const run = action => controller.run("web:fixture", view.webContents, "main", "turn", action, AbortSignal.timeout(20000));
const find = (snapshot, name, role) => { const node = snapshot.nodes.find(n => n.name === name && (!role || n.role === role)); assert.ok(node?.ref, 'Missing AX ref for ' + name + ' / ' + role); return node.ref; };
let result;
try {
  let snapshot = await run({ type: "snapshot" });
  await run({ type: "type", ref: find(snapshot, "Query", "textbox"), text: "side test", clear: true });
  snapshot = await run({ type: "snapshot" });
  await run({ type: "click", ref: find(snapshot, "Search", "button") });
  await run({ type: "wait", text: "side test", timeoutMs: 2000 });
  assert.equal(await view.webContents.executeJavaScript('document.getElementById("result").textContent'), "side test");
  snapshot = await run({ type: "snapshot" });
  await run({ type: "select", ref: find(snapshot, "Category", "combobox"), value: "b" });
  assert.equal(await view.webContents.executeJavaScript('document.getElementById("category").value'), "b");
  const screenshot = await run({ type: "screenshot", fullPage: true });
  assert.ok(Buffer.from(screenshot.image.data, "base64").length > 1000);
  assert.ok(JSON.stringify(screenshot).length < 1048576);
  await writeFile(${JSON.stringify(resolve(output, "page.jpg"))}, Buffer.from(screenshot.image.data, "base64"));
  view.setVisible(false);
  const hiddenScreenshot = await run({ type: "screenshot" });
  assert.ok(Buffer.from(hiddenScreenshot.image.data, "base64").length > 1000);
  view.setVisible(true);
  snapshot = await run({ type: "snapshot" });
  const stale = find(snapshot, "Search", "button");
  await run({ type: "navigate", url: 'http://127.0.0.1:' + server.address().port + '/next' });
  await assert.rejects(run({ type: "click", ref: stale }), /stale_ref/);
  controller.release("main", "turn");
  assert.equal(view.webContents.debugger.isAttached(), false);
  result = { passed: true, screenshotBytes: Buffer.from(screenshot.image.data, "base64").length, hiddenScreenshotBytes: Buffer.from(hiddenScreenshot.image.data, "base64").length, activity };
  console.log(JSON.stringify(result));
} catch (error) { console.error(error); process.exitCode = 1; result = { passed: false, error: String(error) }; }
finally { controller.dispose(); window.destroy(); server.closeAllConnections(); server.close(); await writeFile(${JSON.stringify(resolve(output, "result.json"))}, JSON.stringify(result, null, 2)); app.exit(process.exitCode || 0); }
}).catch(error => { console.error(error); app.exit(1); });
`;
const transpile = (source, fileName) => ts.transpileModule(source, { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
await writeFile(resolve(output, "package.json"), JSON.stringify({ type: "commonjs" }));
for (const name of ["side-browser-controller", "resource-web-preview", "resource-chrome-profile-import"]) {
  const source = await readFile(resolve(directory, "src/main", name + ".ts"), "utf8");
  await writeFile(resolve(output, name + ".js"), transpile(source, name + ".ts"));
}
await writeFile(resolve(output, "run.cjs"), transpile(entry, "run.ts"));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [resolve(output, "run.cjs")], { cwd: directory, env, stdio: "inherit" });
const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
child.once("exit", (code, signal) => { clearTimeout(timer); process.exitCode = code ?? (signal ? 1 : 0); });
await new Promise(resolve => child.once("exit", resolve));
