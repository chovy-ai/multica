import { BUILT_IN_STATUS_CATEGORY, BUILT_IN_STATUS_LABEL } from "@multica/core/issues/config";

const chineseStatusLabels: Record<string, string> = {
  backlog: "待规划", todo: "待办", in_progress: "进行中", in_review: "审核中",
  done: "已完成", blocked: "已阻塞", cancelled: "已取消",
};

export function mentionTaskStatus(item: { status?: string; statusLabel?: string; statusCategory?: string }, locale: string) {
  const status = item.status?.trim();
  if (!status) return null;
  const builtIn = Object.hasOwn(BUILT_IN_STATUS_LABEL, status) ? status as keyof typeof BUILT_IN_STATUS_LABEL : null;
  const category = builtIn ? BUILT_IN_STATUS_CATEGORY[builtIn] : item.statusCategory;
  return {
    label: builtIn ? locale === "zh-CN" ? chineseStatusLabels[status] : BUILT_IN_STATUS_LABEL[builtIn] : item.statusLabel?.trim() || status,
    category: category && ["unstarted", "started", "done", "closed"].includes(category) ? category : "unknown",
  };
}

export function mentionTaskTitle(title: string) {
  const match = /^([A-Z][A-Z0-9_]*-\d+)\s+(.+)$/s.exec(title);
  return match ? { identifier: match[1], title: match[2] } : { identifier: null, title };
}
