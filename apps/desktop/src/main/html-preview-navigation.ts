import type { WebContents } from "electron";

/** srcdoc previews may execute JavaScript but must never navigate to a real origin. */
export function installHtmlPreviewNavigationGuard(contents: WebContents): void {
  contents.on("will-frame-navigate", (event) => {
    if (event.url === "about:srcdoc") return;
    if (event.frame?.url === "about:srcdoc" || event.initiator?.url === "about:srcdoc") event.preventDefault();
  });
}
