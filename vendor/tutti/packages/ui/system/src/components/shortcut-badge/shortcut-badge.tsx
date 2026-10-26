import * as React from "react";

import { cn } from "#lib/utils";

function ShortcutBadge({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="shortcut-badge"
      className={cn(
        "inline-flex h-5 min-w-0 max-w-full shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-[color-mix(in_srgb,var(--transparency-block)_72%,transparent)] px-1.5 py-1 font-[inherit] text-[11px] leading-none font-semibold whitespace-nowrap text-[var(--text-tertiary)] not-italic [font-variant:normal] [text-overflow:ellipsis]",
        className
      )}
      {...props}
    />
  );
}

export { ShortcutBadge };
