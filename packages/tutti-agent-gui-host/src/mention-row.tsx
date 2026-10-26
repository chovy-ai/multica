import { Badge } from "@multica/ui/components/ui/badge";
import { renderMentionRow, type MentionRowItem, type MentionRowRenderOptions } from "@tutti-os/ui-rich-text/at-panel";
import { mentionTaskStatus, mentionTaskTitle } from "./mention-task-presentation";
import { isTaskCreationMention } from "./task-creation-mention";

/** Keep the source selection controller; task chrome belongs to Multica. */
export function renderMulticaMentionRow(
  item: { kind: string; targetId?: string; title?: string; status?: string; statusLabel?: string; statusCategory?: string },
  locale: string,
  fallback: MentionRowItem,
  options: MentionRowRenderOptions,
) {
  if (isTaskCreationMention(item)) return <span className="multica-mention-task-row" title={item.title}><span aria-hidden="true" className="multica-mention-task-identifier">＋</span><span className="multica-mention-task-title">{locale === "en" ? "New task" : "新建任务"}</span></span>;
  if (item.kind !== "workspace-issue" || !item.title) return renderMentionRow(fallback, options);
  const title = mentionTaskTitle(item.title);
  const status = mentionTaskStatus(item, locale);
  return <span className="multica-mention-task-row" title={item.title}>
    {title.identifier && <span className="multica-mention-task-identifier">{title.identifier}</span>}
    <span className="multica-mention-task-title">{title.title}</span>
    {status && <Badge variant="secondary" className="multica-mention-task-status" data-category={status.category} data-status={item.status}>{status.label}</Badge>}
  </span>;
}
