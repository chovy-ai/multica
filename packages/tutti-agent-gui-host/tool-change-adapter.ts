import type { Plugin } from "vite";

/** Adds Desktop tool-result evidence without changing the vendored GUI snapshot. */
export function toolChangeAdapter(): Plugin {
  return {
    name: "multica-tool-result-evidence", enforce: "pre",
    transform(code, id) {
      const path = id.replaceAll("\\", "/");
      if (!path.endsWith("/tool-renderers/AgentExpandedToolContent.tsx")) return;
      const marker = "  return content;";
      if (!code.includes(marker)) throw new Error("AgentExpandedToolContent evidence anchor changed");
      return { code: `import { ToolResultEvidence } from "@multica/tutti-agent-gui-host/side-entry";\n${code.replace(marker, "  return <>{content}<ToolResultEvidence call={call} /></>;")}`, map: null };
    },
  };
}
