import type { Plugin } from "vite";

/** Adds the Desktop-owned resource action without changing the vendored GUI snapshot. */
export function toolChangeAdapter(): Plugin {
  return {
    name: "multica-tool-change-action", enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("/agentConversation/components/AgentToolCallCard.tsx")) return;
      const marker = "    </div>\n  );\n});";
      if (!code.includes(marker)) throw new Error("AgentToolCallCard resource action anchor changed");
      return { code: `import { FileChangeAction } from "@multica/tutti-agent-gui-host/side-entry";\n${code.replace(marker, "      <FileChangeAction call={call} />\n" + marker)}`, map: null };
    },
  };
}
