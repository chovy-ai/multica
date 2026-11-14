import type { Plugin } from "vite";

/** Adds the Desktop-owned resource action without changing the vendored GUI snapshot. */
export function toolChangeAdapter(): Plugin {
  return {
    name: "multica-tool-change-action", enforce: "pre",
    transform(code, id) {
      const path = id.replaceAll("\\", "/");
      if (path.endsWith("/tool-renderers/AgentExpandedToolContent.tsx")) {
        const marker = "  return content;";
        if (!code.includes(marker)) throw new Error("AgentExpandedToolContent evidence anchor changed");
        return { code: `import { ToolResultEvidence } from "@multica/tutti-agent-gui-host/side-entry";\n${code.replace(marker, "  return <>{content}<ToolResultEvidence call={call} /></>;")}`, map: null };
      }
      if (!path.endsWith("/agentConversation/components/AgentToolCallCard.tsx")) return;
      const marker = "    </div>\n  );\n});";
      if (!code.includes(marker)) throw new Error("AgentToolCallCard resource action anchor changed");
      return { code: `import { FileChangeAction } from "@multica/tutti-agent-gui-host/side-entry";\n${code.replace(marker, "      <FileChangeAction call={call} />\n" + marker)}`, map: null };
    },
  };
}
