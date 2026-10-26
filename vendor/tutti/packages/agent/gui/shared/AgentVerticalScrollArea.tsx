import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type JSX
} from "react";
import { CustomScrollArea } from "../app/renderer/components/ui/custom-scroll-area";
import { cn } from "../app/renderer/lib/utils";

export interface AgentVerticalScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  viewportClassName?: string;
  scrollbarClassName?: string;
  scrollbarThumbClassName?: string;
  syncKey?: unknown;
}

export const AgentVerticalScrollArea = forwardRef<
  HTMLDivElement,
  AgentVerticalScrollAreaProps
>(function AgentVerticalScrollArea(
  {
    children,
    className,
    viewportClassName,
    scrollbarClassName,
    scrollbarThumbClassName,
    syncKey,
    ...props
  },
  forwardedRef
): JSX.Element {
  "use memo";
  return (
    <CustomScrollArea
      ref={forwardedRef}
      className={cn("agent-vertical-scroll-area min-h-0 min-w-0", className)}
      viewportClassName={cn(
        "min-h-0 min-w-0 overflow-x-hidden overflow-y-auto",
        viewportClassName
      )}
      scrollbarClassName={cn(
        "agent-vertical-scroll-area__scrollbar top-2 right-2 bottom-2",
        scrollbarClassName
      )}
      scrollbarThumbClassName={cn(
        "agent-vertical-scroll-area__scrollbar-thumb",
        scrollbarThumbClassName
      )}
      syncKey={syncKey ?? children}
      {...props}
    >
      {children}
    </CustomScrollArea>
  );
});
