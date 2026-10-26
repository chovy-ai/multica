import "./env";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentGuiInitSnapshot } from "../packages/tutti-agent-gui-host/src/protocol";
import type { ChatSession } from "../packages/core/types";

const artifact = `<!doctype html><html><head><title>Project summary</title></head><body>
<h2>Interactive project summary</h2>
<button id="increment" onclick="document.querySelector('#count').textContent = ++count">Add one</button><output id="count">0</output>
<div style="height:160px"><canvas id="chart" aria-label="Project chart"></canvas></div><div id="d3"></div>
<output id="isolation"></output><button id="network">Check network isolation</button><output id="network-result"></output>
<script>
let count = 0;
const canvas = document.querySelector('#chart');
const parent = canvas.parentElement;
new Chart(canvas, {type:'bar', data:{labels:['A','B'],datasets:[{label:'Tasks',data:[3,7]}]},options:{animation:false,responsive:true,maintainAspectRatio:false}});
canvas.dataset.ready = 'yes';
canvas.dataset.color = Chart.getChart(canvas).data.datasets[0].backgroundColor || '';
d3.select('#d3').append('svg').attr('aria-label','D3 diagram').attr('height',40).append('circle').attr('cx',20).attr('cy',20).attr('r',12).attr('fill','currentColor');
const denied = [];
try { window.parent.document.body.dataset.previewEscaped = 'yes'; } catch { denied.push('parent'); }
try { localStorage.getItem('auth'); } catch { denied.push('storage'); }
if (typeof window.desktopAPI === 'undefined') denied.push('bridge');
document.querySelector('#isolation').textContent = denied.join(',');
document.querySelector('#network').onclick = () => fetch('https://blocked.invalid/private').catch(() => document.querySelector('#network-result').textContent = 'blocked');
</script></body></html>`;

async function mountGui(page: Page, provider: "codex" | "claude", content: string, streaming = false, globalPreview = false) {
  const at = "2026-10-24T18:00:00Z";
  const session: ChatSession = { id: `html-${provider}`, workspace_id: "html-workspace", creator_id: "html-user", agent_id: `local:${provider}`, title: "HTML preview validation", status: "active", created_at: at, updated_at: at, has_unread: false };
  const snapshot: AgentGuiInitSnapshot = {
    workspaceId: session.workspace_id, workspaceSlug: "html-test", userId: session.creator_id,
    locale: "en", theme: "dark", local: true, hostActive: true, hostVisible: true,
    agents: [], sessions: [session], activeSessionId: session.id, selectedAgentId: session.agent_id,
    executionTargets: [{ id: session.agent_id, provider, name: provider === "codex" ? "Codex" : "Claude Code", iconUrl: "", canInvoke: true, runtimeBound: true, runtimeOnline: true }],
  };
  const fixture = `/@fs/${resolve("e2e/fixtures/global-svg-preview.tsx")}`;
  await page.route("**/__test/agent-html-preview", (route) => route.fulfill({ contentType: "text/html", body: globalPreview ? `<div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true; await import(${JSON.stringify(fixture)});</script>` : '<button id="finish">Finish generation</button><button id="theme">Switch theme</button><button id="locale">Switch language</button><iframe title="HTML GUI validation" style="display:block;width:100%;height:1100px;border:0"></iframe>' }));
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/__test/agent-html-preview");
  await expect(page.locator('iframe[title="HTML GUI validation"]')).toBeVisible();
  await page.evaluate(({ snapshot, session, content, streaming }) => {
    let running = streaming;
    let port: MessagePort;
    const storage = new Map<string, string>();
    const frame = document.querySelector("iframe")!;
    document.querySelector("#finish")!.addEventListener("click", () => {
      running = false;
      port.postMessage({ type: "event", event: { type: "invalidate", scope: "session", sessionId: session.id } });
    });
    document.querySelector("#theme")!.addEventListener("click", () => {
      snapshot.theme = snapshot.theme === "dark" ? "light" : "dark";
      port.postMessage({ type: "event", event: { type: "init", snapshot } });
    });
    document.querySelector("#locale")!.addEventListener("click", () => {
      snapshot.locale = "zh-CN";
      port.postMessage({ type: "event", event: { type: "init", snapshot } });
    });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== "multica:agent-gui:ready") return;
      const channel = new MessageChannel(); port = channel.port1;
      port.onmessage = (event) => {
        const request = event.data;
        if (request.type !== "request") return;
        let result: unknown;
        switch (request.method) {
          case "workspace.load": result = snapshot; break;
          case "session.load": result = { session, messages: [
            { id: "html-question", chat_session_id: session.id, role: "user", content: "Show an interactive project summary", task_id: "html-run", created_at: session.created_at },
            ...(!running ? [{ id: "html-answer", chat_session_id: session.id, role: "assistant", content, task_id: "html-run", created_at: session.created_at }] : []),
          ], tasks: [], pending: running ? { task_id: "html-run", status: "running", created_at: session.created_at } : {} }; break;
          case "task.messages": result = running ? [{ seq: 1, type: "text", content, created_at: session.created_at }] : []; break;
          case "context.tasks": result = []; break;
          case "storage.read": result = storage.get(request.params.key) ?? null; break;
          case "storage.write": storage.set(request.params.key, request.params.value); break;
          case "models.list": result = { id: "html-catalog", runtime_id: session.agent_id, status: "completed", supported: true, models: [] }; break;
          case "usage.read": result = { provider: snapshot.executionTargets![0]!.provider, context: { usedTokens: null, limitTokens: null, model: null, updatedAt: null }, account: { status: "unavailable", windows: [], plan: null, updatedAt: null } }; break;
          case "session.watch": case "session.markRead": case "host.promptApplied": break;
          default:
            document.body.dataset.unexpectedRequest = request.method;
            port.postMessage({ type: "response", id: request.id, error: { message: `Unexpected request ${request.method}` } }); return;
        }
        port.postMessage({ type: "response", id: request.id, result });
      };
      port.start();
      frame.contentWindow!.postMessage({ type: "multica:agent-gui:connect", snapshot }, location.origin, [channel.port2]);
    });
    frame.src = "/tutti-agent-gui/index.html";
  }, { snapshot, session, content, streaming });
  return page.frameLocator('iframe[title="HTML GUI validation"]');
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} replies render HTML, bundled charts and isolated interactions`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let apiRequests = 0;
    let leakedRequests = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests++; });
    await page.route("https://blocked.invalid/**", (route) => { leakedRequests++; return route.abort(); });
    const gui = await mountGui(page, provider, `A project summary:\n\n\`\`\`html\n${artifact}\n\`\`\`\n\n\`\`\`js\nconst ordinaryCode = true;\n\`\`\`\n\n\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\``);
    const preview = gui.getByTestId("multica-html-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    const html = preview.frameLocator('iframe');
    await expect(html.getByRole("heading", { name: "Interactive project summary" })).toBeVisible();
    await expect(html.locator("#chart")).toHaveAttribute("data-ready", "yes");
    await expect(preview.getByRole("status")).toHaveCount(0);
    await expect(html.locator("#chart")).toHaveAttribute("data-color", /.+/);
    expect((await preview.getByRole("button", { name: "Preview", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await expect(html.locator('svg[aria-label="D3 diagram"] circle')).toHaveCount(1);
    await expect(html.locator("#isolation")).toHaveText("parent,storage,bridge");
    await html.getByRole("button", { name: "Add one" }).click();
    await expect(html.locator("#count")).toHaveText("1");
    await preview.getByRole("button", { name: "Source", exact: true }).click();
    await expect(preview.getByTestId("multica-html-source")).toContainText("new Chart");
    await preview.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(html.locator("#count")).toHaveText("1");
    await preview.getByRole("button", { name: "Expand preview", exact: true }).click();
    await expect(preview.getByRole("button", { name: "Collapse preview", exact: true })).toHaveAttribute("aria-expanded", "true");
    expect((await preview.locator("iframe").boundingBox())!.height).toBeGreaterThan(360);
    await preview.getByRole("button", { name: "Run again", exact: true }).click();
    await expect(html.locator("#count")).toHaveText("0");
    await expect(gui.locator("pre").filter({ hasText: "const ordinaryCode" })).toBeVisible();
    await expect(gui.getByTestId("agent-mermaid-preview")).toBeVisible();
    await expect(preview.getByRole("alert")).toHaveCount(0);
    await preview.getByRole("button", { name: "Collapse preview", exact: true }).click();
    await preview.scrollIntoViewIfNeeded();
    await mkdir(".tmp/local-conversations", { recursive: true });
    await preview.screenshot({ path: `.tmp/local-conversations/html-${provider}-preview.png` });
    await page.getByRole("button", { name: "Switch theme" }).click();
    await expect.poll(() => html.locator("html").evaluate((element) => getComputedStyle(element).colorScheme)).toBe("light");
    await expect(html.locator("#chart")).toHaveAttribute("data-ready", "yes");
    await preview.screenshot({ path: `.tmp/local-conversations/html-${provider}-light.png` });
    await page.getByRole("button", { name: "Switch language" }).click();
    await expect(preview.getByRole("button", { name: "源码", exact: true })).toBeVisible();
    await expect(preview.getByRole("status")).toHaveCount(0);
    await html.getByRole("button", { name: "Check network isolation" }).click();
    await expect(html.locator("#network-result")).toHaveText("blocked");
    expect(leakedRequests).toBe(0); expect(apiRequests).toBe(0);
    await expect(page.locator("body")).not.toHaveAttribute("data-preview-escaped");
    await expect(page.locator("body")).not.toHaveAttribute("data-unexpected-request");
    expect(errors).toEqual([]);
  });
}

test("HTML waits for streaming completion and reports script errors without breaking chat", async ({ page }) => {
  const content = '```html\n<h2>Completed artifact</h2><script>throw new Error("Named HTML failure")</script>\n```';
  const gui = await mountGui(page, "codex", content, true);
  const preview = gui.getByTestId("multica-html-preview");
  await expect(preview.getByText("Preview appears when generation finishes")).toBeVisible({ timeout: 30_000 });
  await expect(preview.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Finish generation" }).click();
  await expect(preview.frameLocator("iframe").getByRole("heading", { name: "Completed artifact" })).toBeVisible();
  await expect(preview.getByRole("alert")).toContainText("Named HTML failure");
  await expect(gui.getByTestId("agent-gui-composer-editor")).toBeVisible();
});

const svgArtifact = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 240" role="img" onload="document.documentElement.setAttribute('data-svg-script-ran','yes')">
  <title>Project workflow</title>
  <defs><linearGradient id="paint"><stop stop-color="var(--brand)"/><stop offset="1" stop-color="var(--muted)"/></linearGradient><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0L10 5L0 10" fill="var(--brand)"/></marker><circle id="dot" r="5"/></defs>
  <rect x="20" y="80" width="160" height="80" rx="12" fill="url(#paint)"/>
  <rect x="270" y="80" width="160" height="80" rx="12" fill="var(--muted)" stroke="var(--border)"/>
  <rect x="520" y="80" width="160" height="80" rx="12" fill="var(--muted)" stroke="var(--border)"/>
  <g fill="currentColor" font-size="20" text-anchor="middle"><text x="100" y="127">Plan</text><text x="350" y="127">Build</text><text x="600" y="127">Review</text></g>
  <g stroke="var(--brand)" stroke-width="3" marker-end="url(#arrow)"><path d="M190 120H250"/><path d="M440 120H500"/></g>
  <use href="#dot" x="350" y="195" fill="var(--brand)"/>
  <image href="https://blocked.invalid/diagram.png" x="-50" y="-50" width="10" height="10"/>
  <script><![CDATA[document.documentElement.setAttribute('data-svg-script-ran','yes');]]></script>
</svg>`;

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} SVG global popup covers the workspace and restores the same conversation frame`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const gui = await mountGui(page, provider, `\`\`\`svg\n${svgArtifact}\n\`\`\``, false, true);
    const frame = page.locator('iframe[title="HTML GUI validation"]');
    const original = (await frame.boundingBox())!;
    const preview = gui.getByRole("region", { name: "SVG", exact: true });
    const graphic = preview.frameLocator("iframe");
    const image = graphic.getByRole("img", { name: "Project workflow", exact: true });
    await expect(image).toBeVisible();
    await graphic.locator("html").evaluate((element) => element.setAttribute("data-retained", "yes"));
    await image.click();
    const globalDialog = page.getByRole("dialog", { name: "SVG", exact: true });
    const dialog = gui.getByRole("dialog", { name: "SVG preview", exact: true });
    await expect(globalDialog).toBeVisible();
    const popup = (await globalDialog.boundingBox())!;
    expect(popup.x).toBe(0); expect(popup.y).toBe(0);
    expect(popup.width).toBe(page.viewportSize()!.width);
    expect(popup.height).toBe(page.viewportSize()!.height);
    expect((await dialog.boundingBox())!.x).toBeLessThan(original.x);
    expect((await dialog.boundingBox())!.width).toBeGreaterThan(original.width);
    await expect(graphic.locator("html")).toHaveAttribute("data-retained", "yes");
    await preview.getByRole("button", { name: "Zoom in SVG", exact: true }).click();
    await mkdir(".tmp/local-conversations", { recursive: true });
    await page.screenshot({ path: `.tmp/local-conversations/svg-${provider}-global.png` });
    await preview.getByRole("button", { name: "Source", exact: true }).click();
    await expect(preview.getByTestId("multica-html-source")).toContainText('marker-end="url(#arrow)"');
    await preview.getByRole("button", { name: "Preview", exact: true }).click();
    await dialog.getByRole("button", { name: "Close preview", exact: true }).click();
    await expect(globalDialog).toHaveCount(0);
    expect(await frame.boundingBox()).toEqual(original);
    await expect(graphic.locator("html")).toHaveAttribute("data-retained", "yes");
    await expect.poll(() => graphic.getByTestId("multica-svg-stage").evaluate((element) => (element as HTMLElement).style.width)).toBe("125%");
    await expect(page.locator('input[aria-label="Main draft"]')).toHaveValue("Keep my main draft");
    await expect(preview.getByRole("button", { name: "Expand preview", exact: true })).toBeFocused();
    await image.click();
    await expect(globalDialog).toBeVisible();
    await image.press("Escape");
    await expect(globalDialog).toHaveCount(0);
    await page.setViewportSize({ width: 620, height: 800 });
    await preview.getByRole("button", { name: "Expand preview", exact: true }).click();
    await expect(globalDialog).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBeGreaterThan(580);
    const bounds = (await dialog.boundingBox())!;
    await page.mouse.click(bounds.x - 6, bounds.y + bounds.height / 2);
    await expect(globalDialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} SVG opens a large preview on click and returns without resetting its frame or zoom`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const gui = await mountGui(page, provider, `\`\`\`svg\n${svgArtifact}\n\`\`\`\n\nFollowing diagram text`);
    const preview = gui.getByRole("region", { name: "SVG", exact: true });
    const graphic = preview.frameLocator("iframe");
    const image = graphic.getByRole("img", { name: "Project workflow", exact: true });
    await expect(image).toBeVisible({ timeout: 30_000 });
    await expect(preview.getByRole("status")).toHaveCount(0);
    await graphic.locator("html").evaluate((element) => element.setAttribute("data-retained", "yes"));
    const inline = (await preview.boundingBox())!;
    const following = gui.getByText("Following diagram text", { exact: true });
    const followingTop = (await following.boundingBox())!.y;
    await preview.getByRole("button", { name: "Zoom in SVG", exact: true }).click();
    await image.click();
    const dialog = gui.getByRole("dialog", { name: "SVG preview", exact: true });
    await expect(dialog).toBeVisible();
    expect((await dialog.boundingBox())!.height).toBeGreaterThan(inline.height);
    expect((await following.boundingBox())!.y).toBeCloseTo(followingTop, 0);
    await expect(graphic.locator("html")).toHaveAttribute("data-retained", "yes");
    const stage = graphic.getByTestId("multica-svg-stage");
    await expect.poll(() => stage.evaluate((element) => (element as HTMLElement).style.width)).toBe("125%");
    await preview.getByRole("button", { name: "Zoom in SVG", exact: true }).click();
    await dialog.getByRole("button", { name: "Close preview", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await preview.locator("iframe").boundingBox())!.height).toBe(360);
    await expect.poll(() => stage.evaluate((element) => (element as HTMLElement).style.width)).toBe("150%");
    const expand = preview.getByRole("button", { name: "Expand preview", exact: true });
    await expect(expand).toBeFocused();
    const imageButton = graphic.getByRole("button", { name: "Expand preview", exact: true });
    await imageButton.focus();
    await imageButton.press("Enter");
    await expect(dialog).toBeVisible();
    await image.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(expand).toBeFocused();
    await image.click();
    await expect(dialog).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    await page.mouse.click(bounds.x - 6, bounds.y + bounds.height / 2);
    await expect(dialog).toHaveCount(0);
    await expect(graphic.locator("html")).toHaveAttribute("data-retained", "yes");
    await expect(gui.getByTestId("agent-gui-composer-editor")).toBeVisible();
    await mkdir(".tmp/local-conversations", { recursive: true });
    await preview.getByRole("button", { name: "Fit to panel", exact: true }).click();
    await image.click();
    await expect(dialog).toBeVisible();
    await dialog.screenshot({ path: `.tmp/local-conversations/svg-${provider}-expanded.png` });
    await dialog.getByRole("button", { name: "Close preview", exact: true }).press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Switch theme", exact: true }).click();
    await expect.poll(() => graphic.locator("html").evaluate((element) => getComputedStyle(element).colorScheme).catch(() => null)).toBe("light");
    await page.getByRole("button", { name: "Switch language", exact: true }).click();
    await graphic.getByRole("button", { name: "展开预览", exact: true }).click();
    const localizedDialog = gui.getByRole("dialog", { name: "SVG 预览", exact: true });
    await expect(localizedDialog).toBeVisible();
    await localizedDialog.screenshot({ path: `.tmp/local-conversations/svg-${provider}-expanded-light.png` });
    await localizedDialog.getByRole("button", { name: "关闭预览", exact: true }).click();
    await expect(localizedDialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
  test(`${provider} SVG fences render images with zoom, theme and disabled scripts`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let leaked = 0;
    let chartLibraries = 0;
    await page.route("https://blocked.invalid/**", (route) => { leaked++; return route.abort(); });
    page.on("request", (request) => { if (request.url().includes("_virtual_multica-html-libraries")) chartLibraries++; });
    const source = provider === "claude" ? svgArtifact.replace(' xmlns="http://www.w3.org/2000/svg"', "") : `\n<?xml version="1.0"?>${svgArtifact}`;
    const gui = await mountGui(page, provider, `A project workflow:\n\n\`\`\`svg\n${source}\n\`\`\``);
    const preview = gui.getByRole("region", { name: "SVG", exact: true });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    const graphic = preview.frameLocator("iframe");
    const image = graphic.getByRole("img", { name: "Project workflow", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(preview.getByRole("status")).toHaveCount(0);
    await expect(preview.getByRole("alert")).toHaveCount(0);
    await expect(graphic.locator("html")).not.toHaveAttribute("data-svg-script-ran");
    expect(await graphic.locator("html").evaluate(() => typeof (window as unknown as { Chart?: unknown }).Chart)).toBe("undefined");
    const stage = graphic.getByTestId("multica-svg-stage");
    await preview.getByRole("button", { name: "Zoom in SVG", exact: true }).click();
    await expect.poll(() => stage.evaluate((element) => (element as HTMLElement).style.width)).toBe("125%");
    await preview.getByRole("button", { name: "Source", exact: true }).click();
    await expect(preview.getByTestId("multica-html-source")).toContainText('marker-end="url(#arrow)"');
    await preview.getByRole("button", { name: "Preview", exact: true }).click();
    await expect.poll(() => stage.evaluate((element) => (element as HTMLElement).style.width)).toBe("125%");
    await preview.getByRole("button", { name: "Fit to panel", exact: true }).click();
    await expect.poll(() => stage.evaluate((element) => (element as HTMLElement).style.width)).toBe("100%");
    await preview.getByRole("button", { name: "Zoom out SVG", exact: true }).click();
    await expect.poll(() => stage.evaluate((element) => (element as HTMLElement).style.width)).toBe("75%");
    await preview.getByRole("button", { name: "Fit to panel", exact: true }).click();
    await mkdir(".tmp/local-conversations", { recursive: true });
    await preview.screenshot({ path: `.tmp/local-conversations/svg-${provider}-dark.png` });
    await page.getByRole("button", { name: "Switch theme", exact: true }).click();
    // Theme changes replace the sandbox document; a poll may catch its old frame detaching.
    await expect.poll(() => graphic.locator("html").evaluate((element) => getComputedStyle(element).colorScheme).catch(() => null)).toBe("light");
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
    const foreground = await preview.evaluate((element) => getComputedStyle(element).color);
    await expect.poll(() => preview.getByRole("button", { name: "Source", exact: true }).evaluate((element) => getComputedStyle(element).color)).toBe(foreground);
    await preview.screenshot({ path: `.tmp/local-conversations/svg-${provider}-light.png` });
    expect(leaked).toBe(0); expect(chartLibraries).toBe(0); expect(errors).toEqual([]);
  });
}

test("SVG streaming waits and a malformed image does not break other previews", async ({ page }) => {
  const content = `\`\`\`svg\n<svg><g></svg>\n\`\`\`\n\n\`\`\`svg\n${svgArtifact}\n\`\`\``;
  const gui = await mountGui(page, "codex", content, true);
  const previews = gui.getByRole("region", { name: "SVG", exact: true });
  await expect(previews).toHaveCount(2, { timeout: 30_000 });
  await expect(previews.first().getByText("Preview appears when generation finishes")).toBeVisible();
  await expect(previews.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Finish generation", exact: true }).click();
  await expect(previews.first().getByRole("alert")).toContainText("Invalid SVG document");
  await expect(previews.first().getByRole("status")).toHaveCount(0);
  await previews.first().getByRole("button", { name: "Source", exact: true }).click();
  await expect(previews.first().getByTestId("multica-html-source")).toHaveText("<svg><g></svg>");
  await expect(previews.last().frameLocator("iframe").getByRole("img", { name: "Project workflow", exact: true })).toBeVisible();
  await expect(gui.getByTestId("agent-gui-composer-editor")).toBeVisible();
});
