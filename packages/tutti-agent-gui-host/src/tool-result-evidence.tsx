import { observer } from "mobx-react-lite";
import { localV2ReportedFileChangeSchema } from "@multica/core/local-conversation/v2";
import { AgentUnifiedPatchViewer } from "../../../vendor/tutti/packages/agent/gui/shared/agentConversation/components/tool-renderers/file-diff/AgentUnifiedPatchViewer";

const pathStyle = { overflowWrap: "anywhere" } as const;
const resultStyle = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

const changesSchema = localV2ReportedFileChangeSchema.array();

/** Provider-reported per-call evidence; independent of the verified net-change ledger. */
export const ToolResultEvidenceContent = observer(function ToolResultEvidenceContent({ output, chinese }: { output: Record<string, unknown> | null; chinese: boolean }) {
  const changes = changesSchema.safeParse(output?.fileChanges).data ?? [];
  const result = output?.providerResult;
  const incomplete = output?.changesIncomplete === true;
  const elapsed = typeof output?.elapsedSeconds === "number" ? output.elapsedSeconds : null;
  if (!changes.length && !result && !incomplete && elapsed === null) return null;
  return <div className="workspace-agents-status-panel__detail-tool-body min-w-0 break-words">
    {elapsed !== null ? <div className="text-caption text-muted-foreground">{chinese ? `已用时 ${elapsed} 秒` : `Elapsed: ${elapsed}s`}</div> : null}
    {changes.length ? <div className="text-caption text-muted-foreground">{chinese ? "工具报告的文件变更" : "Reported file changes"}</div> : null}
    {changes.map((change, index) => change.diff
      ? <AgentUnifiedPatchViewer key={`${change.path}:${index}`} path={change.path} diffText={change.diff} compact flat />
      : <div key={`${change.path}:${index}`}><code style={pathStyle}>{change.path}</code></div>)}
    {incomplete ? <p>{chinese ? "变更记录不完整，部分 diff 未提供。" : "Changes are incomplete; some diffs were not provided."}</p> : null}
    {result ? <details><summary>{chinese ? "详细结果" : "Result details"}</summary><pre className="max-h-80 overflow-auto" style={resultStyle}>{JSON.stringify(result, null, 2)}</pre></details> : null}
  </div>;
});
