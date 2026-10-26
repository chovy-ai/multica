import { type JSX } from "react";
import { Button } from "@tutti-os/ui-system";
import type { IssueManagerController } from "../../react/index.ts";

export function IssueManagerTaskAcceptanceCard({
  controller,
  taskId
}: {
  controller: IssueManagerController;
  taskId?: string | null;
}): JSX.Element {
  const copy = controller.copy;
  const updateStatus = (status: "completed" | "not_started") => {
    if (taskId) {
      void controller.setTaskStatus(taskId, status);
      return;
    }
    void controller.setSelectedTaskStatus(status);
  };

  return (
    <div className="grid gap-2 rounded-md border border-[var(--tutti-purple-border)] bg-[var(--tutti-purple-bg)] px-3 py-2">
      <div className="min-w-0 text-[11px] font-normal leading-[1.45] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
        <span className="font-semibold text-[var(--text-primary)]">
          {copy.t("labels.taskAcceptance")}
        </span>
        <span className="mx-1 text-[var(--text-tertiary)]">·</span>
        <span>{copy.t("messages.taskAcceptanceHint")}</span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          className="h-7 px-2 text-[11px] text-[var(--state-danger)] hover:bg-[var(--on-danger)] hover:text-[var(--state-danger)]"
          type="button"
          variant="ghost"
          onClick={() => updateStatus("not_started")}
        >
          {copy.t("actions.rejectTask")}
        </Button>
        <Button
          className="h-7 px-2.5 text-[11px]"
          type="button"
          variant="secondary"
          onClick={() => updateStatus("completed")}
        >
          {copy.t("actions.acceptTask")}
        </Button>
      </div>
    </div>
  );
}
