import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "#lib/utils";

function ResizablePanelGroup({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group>) {
  return (
    <ResizablePrimitive.Group
      data-orientation={orientation}
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
      orientation={orientation}
    />
  );
}

function ResizablePanel(
  props: React.ComponentProps<typeof ResizablePrimitive.Panel>
) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  className,
  withHandle,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "group relative flex items-center justify-center bg-transparent outline-none after:absolute after:bg-border/70 after:transition-colors hover:after:bg-border focus-visible:after:bg-ring aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-px aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=vertical]:h-full aria-[orientation=vertical]:w-px aria-[orientation=vertical]:cursor-col-resize aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:left-1/2 aria-[orientation=vertical]:after:w-px aria-[orientation=vertical]:after:-translate-x-1/2",
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex items-center justify-center rounded-full bg-border/85 opacity-0 transition-[background-color,opacity] group-hover:bg-border group-hover:opacity-100 group-focus-visible:bg-border group-focus-visible:opacity-100 group-aria-[orientation=horizontal]:h-[3px] group-aria-[orientation=horizontal]:w-10 group-aria-[orientation=vertical]:h-10 group-aria-[orientation=vertical]:w-[3px]" />
      ) : null}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
