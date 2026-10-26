import { type ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tutti-os/ui-system";

const TRUNCATED_TITLE_TOOLTIP_DELAY_MS = 300;

export function IssueManagerTitleTooltip({
  children,
  title
}: {
  children: ReactElement;
  title: string;
}): ReactElement {
  return (
    <Tooltip delayDuration={TRUNCATED_TITLE_TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        className="max-w-[min(420px,calc(100vw-32px))] whitespace-normal text-left [overflow-wrap:anywhere]"
        side="top"
      >
        {title}
      </TooltipContent>
    </Tooltip>
  );
}
