import * as React from "react";
import { Slot } from "radix-ui";

import { cn } from "#lib/utils";

const menuSurfaceClassName =
  "t-dropdown flex flex-col gap-0.5 rounded-[8px] border border-[var(--border-1)] bg-[var(--background-fronted)] p-1 text-[13px] text-[var(--text-primary)] shadow-panel outline-none";
const menuItemClassName =
  "relative flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-[13px] text-[var(--text-primary)] outline-hidden transition-colors duration-200 select-none hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus:bg-[var(--transparency-hover)] focus:text-[var(--text-primary)] data-[highlighted]:bg-[var(--transparency-hover)] data-[highlighted]:text-[var(--text-primary)] data-disabled:pointer-events-none data-disabled:text-[var(--text-disabled)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:min-w-0 *:[span]:last:flex-1 *:[span]:last:items-center *:[span]:last:gap-2";
const menuItemWithIndicatorClassName = `${menuItemClassName} pr-8`;
const menuItemIndicatorClassName =
  "pointer-events-none absolute right-2 flex size-4 items-center justify-center text-[var(--tutti-purple)]";

type MenuSurfaceProps = React.HTMLAttributes<HTMLDivElement> & {
  "data-state"?: "open" | "closed";
  asChild?: boolean;
  state?: "open" | "closed";
};

const MenuSurface = React.forwardRef<HTMLDivElement, MenuSurfaceProps>(
  (
    {
      asChild = false,
      className,
      "data-state": dataState,
      state = "open",
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot.Root : "div";

    return (
      <Comp
        {...props}
        ref={ref}
        className={cn(menuSurfaceClassName, className)}
        data-state={dataState ?? state}
      />
    );
  }
);
MenuSurface.displayName = "MenuSurface";

export {
  MenuSurface,
  menuItemClassName,
  menuItemIndicatorClassName,
  menuItemWithIndicatorClassName,
  menuSurfaceClassName
};
