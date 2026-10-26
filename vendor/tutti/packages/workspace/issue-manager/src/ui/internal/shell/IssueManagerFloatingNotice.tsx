import { type JSX } from "react";
import { ToastProvider, ToastRoot, ToastTitle } from "@tutti-os/ui-system";
import type { IssueManagerController } from "../../react/index.ts";

export function IssueManagerFloatingNotice({
  notice
}: {
  notice: NonNullable<IssueManagerController["floatingNotice"]>;
}): JSX.Element {
  const variant = notice.tone === "destructive" ? "destructive" : "default";

  return (
    <ToastProvider>
      <ToastRoot
        key={notice.id}
        open
        anchor="node"
        busy={notice.isLoading}
        className="z-30 w-fit max-w-[min(72vw,40rem)] px-4 py-3 shadow-lg"
        nodeInsetTopPx={16}
        variant={variant}
      >
        <ToastTitle className="whitespace-normal [overflow-wrap:anywhere]">
          {notice.title}
        </ToastTitle>
      </ToastRoot>
    </ToastProvider>
  );
}
