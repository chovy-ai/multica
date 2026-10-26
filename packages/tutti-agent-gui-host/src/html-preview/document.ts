import { HTML_PREVIEW_MAX_LENGTH, type MessagePreviewFormat } from "../html-preview-contract";

export interface PreviewLibraries { chart: string; d3: string }
export type PreviewPalette = Partial<Record<"background" | "foreground" | "muted" | "muted-foreground" | "border" | "brand", string>>;

function script(source: string): string {
  return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
}

/** HTML belongs exclusively to the opaque sandbox, never the host DOM. */
export function createHtmlPreviewDocument(source: string, libraries: PreviewLibraries, channel: string, theme: "light" | "dark", palette: PreviewPalette, format: MessagePreviewFormat = "html"): string {
  if (source.length > HTML_PREVIEW_MAX_LENGTH) throw new Error("HTML preview is too large");
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
  const colors = Object.entries(palette).map(([key, value]) => `--${key}:${value};`).join("");
  const svgLoader = `addEventListener('DOMContentLoaded', () => {
    try {
      const namespace = 'http://www.w3.org/2000/svg';
      const parser = new DOMParser();
      let parsed = parser.parseFromString(${JSON.stringify(source.trim())}, 'image/svg+xml');
      let root = parsed.documentElement;
      if (parsed.querySelector('parsererror') || root.localName !== 'svg') throw new Error('Invalid SVG document. Check the source.');
      if (!root.namespaceURI) {
        root.removeAttribute('xmlns');
        const original = new XMLSerializer().serializeToString(root);
        parsed = parser.parseFromString('<svg xmlns="' + namespace + '"' + original.slice(4), 'image/svg+xml');
        root = parsed.documentElement;
      }
      if (root.namespaceURI !== namespace) throw new Error('Invalid SVG namespace. Check the source.');
      const style = parsed.createElementNS(namespace, 'style');
      style.textContent = ${JSON.stringify(`:root{${colors}color:var(--foreground,CanvasText);font-family:system-ui,sans-serif;}`)};
      root.insertBefore(style, root.firstChild);
      const stage = document.createElement('button');
      stage.type = 'button';
      stage.setAttribute('aria-label', 'Expand preview');
      stage.setAttribute('aria-haspopup', 'dialog');
      stage.dataset.testid = 'multica-svg-stage';
      stage.style.cssText = 'display:block;width:100%;height:100%;border:0;padding:0;margin:0;background:transparent;color:inherit;cursor:zoom-in';
      let expanded = false;
      stage.addEventListener('click', () => send('expand', {}));
      addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); send('collapse', {}); } });
      const image = document.createElement('img');
      image.alt = root.querySelector('title')?.textContent?.trim().slice(0, 200) || 'SVG';
      image.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
      image.onload = () => send('ready', {});
      image.onerror = () => report('SVG could not be rendered. Check the source.');
      // SVG image context disables its scripts and external resources.
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root));
      stage.append(image); document.body.append(stage);
      addEventListener('message', (event) => {
        const message = event.data;
        if (event.source !== host || message?.type !== 'multica:svg-preview:zoom' || message.channel !== channel || typeof message.zoom !== 'number' || !Number.isFinite(message.zoom)) return;
        const percent = Math.max(0.25, Math.min(4, message.zoom)) * 100 + '%';
        stage.style.width = percent; stage.style.height = percent;
        expanded = message.expanded === true;
        stage.style.cursor = expanded ? 'default' : 'zoom-in';
        stage.setAttribute('aria-expanded', String(expanded));
        if (typeof message.expandLabel === 'string') stage.setAttribute('aria-label', message.expandLabel);
      });
    } catch (error) { report(error.message || 'SVG could not be rendered. Check the source.'); }
  }, {once: true});`;
  const bootstrap = `(() => {
    const channel = ${JSON.stringify(channel)};
    const host = window.parent;
    const send = (type, value) => host.postMessage({type: 'multica:html-preview', channel, kind: type, ...value}, '*');
    let reported = false;
    const report = (message) => { if (!reported) { reported = true; send('error', {message: String(message).slice(0, 500)}); } };
    addEventListener('error', (event) => report(event.message || 'HTML script failed'));
    addEventListener('unhandledrejection', (event) => report(event.reason?.message || event.reason || 'HTML script failed'));
    addEventListener('securitypolicyviolation', () => report('External resources are unavailable. Use inline content and the bundled libraries.'));
    addEventListener('click', (event) => { const anchor = event.target.closest?.('a'); if (anchor && !anchor.getAttribute('href')?.startsWith('#')) event.preventDefault(); }, true);
    addEventListener('submit', (event) => event.preventDefault(), true);
    ${format === "svg" ? svgLoader : "addEventListener('DOMContentLoaded', () => send('ready', {}), {once: true});"}
  })();`;
  const chartTheme = `if (window.Chart) { const palette = getComputedStyle(document.documentElement); Chart.defaults.color = palette.getPropertyValue('--muted-foreground').trim() || 'CanvasText'; const border = palette.getPropertyValue('--border').trim(); if (border) { Chart.defaults.scale.grid.color = border; Chart.defaults.scale.border.color = border; } }`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:${theme};${colors}}*{box-sizing:border-box}body{margin:0;padding:16px;font:14px/1.6 system-ui,sans-serif;background:var(--background,Canvas);color:var(--foreground,CanvasText)}img,svg,canvas{max-width:100%}button,input,select,textarea{font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}${format === "svg" ? "body{height:100vh;padding:0;overflow:auto}" : ""}</style>${script(bootstrap)}${format === "html" ? script(libraries.chart) + script(libraries.d3) + script(chartTheme) : ""}</head><body>${format === "html" ? source : ""}</body></html>`;
}
