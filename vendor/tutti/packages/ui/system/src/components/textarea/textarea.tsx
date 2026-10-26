import * as React from "react";

import { cn } from "#lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-[6px] border border-transparent bg-[var(--transparency-block)] px-3 py-3 text-[13px] font-normal leading-[1.3] text-[var(--text-primary)] transition-[background-color,border-color,color] outline-none shadow-none placeholder:text-[var(--text-placeholder)] hover:bg-[var(--transparency-hover)] focus:bg-[var(--transparency-hover)] focus-visible:border-transparent focus-visible:bg-[var(--transparency-hover)] focus-visible:ring-0 disabled:cursor-not-allowed disabled:bg-[var(--transparency-block)] disabled:text-[var(--text-disabled)] disabled:opacity-100 aria-invalid:border-[var(--state-danger)] aria-invalid:bg-[var(--transparency-block)] aria-invalid:hover:bg-[var(--transparency-hover)] aria-invalid:focus:bg-[var(--transparency-hover)] aria-invalid:focus-visible:bg-[var(--transparency-hover)] aria-invalid:ring-0 aria-invalid:shadow-none",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
