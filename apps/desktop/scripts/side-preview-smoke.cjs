// Explicit, isolated Electron integration test. Never loads the user's profile.
if (process.env.MULTICA_RUN_NATIVE_PREVIEW_SMOKE !== "1") process.exit(0);
void (async () => {
const { app, BrowserWindow } = await import("electron");
const { default: assert } = await import("node:assert/strict");
const { default: fs } = await import("node:fs");
const { default: os } = await import("node:os");
const { default: path } = await import("node:path");
const { default: http } = await import("node:http");
const { default: ts } = await import("typescript");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "multica-side-preview-"));
app.setPath("userData", path.join(root, "profile"));
app.setName("Multica Side Preview Smoke");
const modulePath = path.join(root, "resource-web-preview.cjs");
for (const [name, output] of [["resource-web-preview", modulePath], ["resource-chrome-profile-import", path.join(root, "resource-chrome-profile-import.js")]]) {
  const source = fs.readFileSync(path.join(__dirname, `../src/main/${name}.ts`), "utf8");
  fs.writeFileSync(output, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { pathToFileURL } = await import("node:url");
const { ResourceWebPreview } = (await import(pathToFileURL(modulePath).href)).default;
let server, window, manager, succeeded = false;
const loaded = async (contents) => { if (!contents.isLoading() && contents.getURL()) return; await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Preview load timed out: ${contents.getURL()} (${contents.getTitle()}, loading=${contents.isLoading()})`)), 10000); contents.once("did-finish-load", () => { clearTimeout(timer); resolve(); }); contents.once("did-fail-load", (_event, code, description) => { if (code !== -3) { clearTimeout(timer); reject(new Error(`Preview load failed: ${code} ${description}`)); } }); }); };
app.whenReady().then(async () => {
  server = http.createServer((request, response) => { response.setHeader("Content-Security-Policy", "frame-ancestors 'none'"); response.end(`<title>${request.url === "/second" ? "Second page" : "Preview document"}</title><h1>Native preview</h1>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const fixtureCookie = { url, name: "imported-login", value: "fixture-new", path: "/", httpOnly: true, secure: false };
  manager = new ResourceWebPreview(window, { platform: "darwin", createSource: () => ({
    discoverChromeCookieProfiles: async () => ({ status: "available", profiles: [{ id: "chrome-fixture", name: "Fixture", source: "chrome" }] }),
    prepareChromeCookieImport: async () => ({ status: "ready", cookies: [fixtureCookie], skipped: 0 }),
  }) });
  await manager.request("test-account:test-workspace", { id: "web:smoke", action: "show", url, bounds: { x: 500, y: 80, width: 480, height: 650 } });
  const view = manager.entries.get("web:smoke").view;
  await loaded(view.webContents);
  const isolation = await view.webContents.executeJavaScript(`({node:typeof require, process:typeof process, desktop:typeof window.desktopAPI, text:document.querySelector('h1').textContent})`);
  assert.deepEqual(isolation, { node: "undefined", process: "undefined", desktop: "undefined", text: "Native preview" });
  assert.deepEqual(view.getBounds(), { x: 500, y: 80, width: 480, height: 650 });
  await manager.request("test-account:test-workspace", { id: "web:smoke", action: "navigate", url: `${url}/second` });
  await loaded(view.webContents); assert.equal(view.webContents.getTitle(), "Second page");
  assert.equal(view.webContents.navigationHistory.canGoBack(), true);
  await manager.request("test-account:test-workspace", { id: "web:smoke", action: "back" }); await loaded(view.webContents);
  assert.equal(view.webContents.getTitle(), "Preview document");
  await manager.request("test-account:test-workspace", { id: "web:peer", action: "show", url });
  await manager.request("test-account:other-workspace", { id: "web:other", action: "show", url });
  const peer = manager.entries.get("web:peer").view;
  const other = manager.entries.get("web:other").view;
  await loaded(peer.webContents); await loaded(other.webContents);
  await view.webContents.session.cookies.set({ ...fixtureCookie, value: "fixture-old" });
  await view.webContents.session.cookies.set({ url, name: "keep", value: "unrelated" });
  let peerReloads = 0, otherReloads = 0;
  peer.webContents.on("did-start-loading", () => peerReloads++);
  other.webContents.on("did-start-loading", () => otherReloads++);
  const input = { id: "web:smoke", profileId: "chrome-fixture", requestId: "fixture-request" };
  assert.equal((await manager.chromeProfiles.import("foreign-account", input)).code, "invalid-target");
  assert.deepEqual(await manager.chromeProfiles.import("test-account:test-workspace", input), { status: "success", imported: 1, skipped: 0, failed: 0 });
  await loaded(view.webContents); await loaded(peer.webContents);
  const imported = await view.webContents.session.cookies.get({ name: "imported-login" });
  assert.equal(imported.length, 1); assert.equal(imported[0].value, "fixture-new");
  assert.equal((await peer.webContents.session.cookies.get({ name: "imported-login" }))[0].value, "fixture-new");
  assert.equal((await other.webContents.session.cookies.get({ name: "imported-login" })).length, 0);
  assert.equal((await view.webContents.session.cookies.get({ name: "keep" }))[0].value, "unrelated");
  assert.equal(peerReloads, 1); assert.equal(otherReloads, 0);
  await assert.rejects(manager.request("other-account", { id: "web:smoke", action: "hide" }), /another workspace/);
  await assert.rejects(manager.request("test-account:test-workspace", { id: "web:smoke", action: "navigate", url: "file:///etc/passwd" }), /http or https/);
  await manager.request("test-account:test-workspace", { id: "web:smoke", action: "hide" }); assert.equal(view.getVisible(), false);
  await manager.request("test-account:test-workspace", { id: "web:smoke", action: "close" });
  await manager.request("test-account:test-workspace", { id: "web:peer", action: "close" });
  await manager.request("test-account:other-workspace", { id: "web:other", action: "close" });
  assert.equal(manager.entries.size, 0);
  succeeded = true;
  console.log(JSON.stringify({ passed: true, sandbox: isolation, nativeBounds: true, frameAncestorsIndependent: true, history: true, scopeIsolation: true, chromeCookieMerge: true, matchingSessionReload: true, modelCalls: 0 }));
}).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  manager?.dispose(); if (window && !window.isDestroyed()) window.destroy(); server?.close();
  app.once("quit", () => fs.rmSync(root, { recursive: true, force: true })); app.exit(succeeded ? 0 : 1);
});

})().catch((error) => { console.error(error); process.exitCode = 1; });
