// Explicit, isolated Electron test. It never opens the user's profile or agents.
if (process.env.MULTICA_RUN_NATIVE_PREVIEW_SMOKE !== "1") process.exit(0);
void (async () => {
 const { app, BrowserWindow, ipcMain } = await import("electron");
 const { default: fs } = await import("node:fs");
 const { default: os } = await import("node:os");
 const { default: path } = await import("node:path");
 const { default: ts } = await import("typescript");
 const { default: assert } = await import("node:assert/strict");
 const { pathToFileURL } = await import("node:url");
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "multica-resources-smoke-"));
 app.setPath("userData", path.join(root,"profile"));
 app.setName("Multica Resources Test");
 for (const name of ["resource-web-preview", "resource-chrome-profile-import"]) {
  fs.writeFileSync(path.join(root, name+".cjs"), ts.transpileModule(fs.readFileSync(path.join(__dirname,"../src/main/"+name+".ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText.replace('require("./resource-chrome-profile-import")','require("./resource-chrome-profile-import.cjs")'));
 }
 const { ResourceWebPreview } = (await import(pathToFileURL(path.join(root,"resource-web-preview.cjs")).href)).default;
 const preload = path.join(root,"preload.cjs");
 fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('__resourcePreviewFixture',{request:(scope,command)=>ipcRenderer.invoke('resource-fixture',scope,command),subscribe:(listener)=>{const handler=(_event,value)=>listener(value);ipcRenderer.on('resource-preview:changed',handler);return ()=>ipcRenderer.removeListener('resource-preview:changed',handler);}});`);
 let window, manager, passed=false;
 const waitFor = async (predicate, description) => { const until=Date.now()+20000;while(Date.now()<until){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error("Timed out: "+description); };
 try {
  await app.whenReady();
  window=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  manager=new ResourceWebPreview(window, { platform: "linux", createSource: () => { throw new Error("No user browser access in this fixture"); } });
  ipcMain.handle('resource-fixture',(_event,scope,command)=>{assert.deepEqual(scope,{userId:"resource-fixture",workspaceId:"resource-fixture"});return manager.request("isolated-resources",command);});
  window.showInactive();
  await window.loadURL((process.env.MULTICA_RESOURCES_FIXTURE_URL??"http://127.0.0.1:16796")+"/__test/resources?native=1&theme=dark");
  const run=code=>window.webContents.executeJavaScript(code);
  await waitFor(()=>manager.entries.size===1&&[...manager.entries.values()][0].view.getVisible(),"native preview visible");
  const original=[...manager.entries.values()][0].view;const webId=original.webContents.id;
  await run(`document.querySelector('[aria-label="Open conversation resources"]').click()`);
  await waitFor(()=>run(`!!document.querySelector('[data-testid="conversation-resources"]')`),"popover opens");
  await waitFor(()=>!original.getVisible(),"native view hides under dialog");
  await run(`document.querySelector('[data-testid="conversation-resources"] [aria-label="Close conversation resources"]').click()`);
  await waitFor(()=>original.getVisible(),"native view restores after close");
  assert.equal(original.webContents.id,webId);assert.equal(manager.entries.size,1);
  await run(`document.querySelector('[aria-label="Close right workspace"]').click()`);
  await waitFor(()=>!original.getVisible(),"native view hides with panel");
  await run(`document.querySelector('[aria-label="Toggle original workspace"]').click()`);
  await waitFor(()=>original.getVisible(),"native view restores with panel");
  assert.equal(original.webContents.id,webId);assert.equal(manager.entries.size,1);
  console.log(JSON.stringify({passed:true,productionPopover:true,nativeViewHiddenAndRestored:true,panelReopen:true,sameWebContents:true,isolatedProfile:true,modelCalls:0}));passed=true;
 } catch(error){console.error(error);} finally {
  manager?.dispose();if(window&&!window.isDestroyed())window.destroy();ipcMain.removeHandler('resource-fixture');
  app.once('quit',()=>fs.rmSync(root,{recursive:true,force:true}));app.exit(passed?0:1);
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
