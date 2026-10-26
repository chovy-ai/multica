import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#lib/utils";

const statusDotVariants = cva("inline-flex shrink-0 rounded-full", {
  variants: {
    tone: {
      neutral: "bg-[var(--text-tertiary)]",
      green: "bg-[var(--state-success)]",
      blue: "bg-[var(--status-running)]",
      amber: "bg-[var(--state-warning)]",
      red: "bg-[var(--state-danger)]"
    },
    size: {
      xs: "size-1.5",
      sm: "size-2",
      md: "size-2.5"
    },
    pulse: {
      true: "animate-pulse",
      false: ""
    }
  },
  defaultVariants: {
    tone: "neutral",
    size: "sm",
    pulse: false
  }
});

type StatusDotProps = VariantProps<typeof statusDotVariants> & {
  ariaLabel?: string;
  title?: string;
  className?: string;
};

function StatusDot({
  tone = "neutral",
  size = "sm",
  pulse = false,
  ariaLabel,
  title,
  className
}: StatusDotProps): React.JSX.Element {
  return (
    <span
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      className={cn(statusDotVariants({ tone, size, pulse }), className)}
      data-pulse={pulse ? "true" : undefined}
      data-size={size}
      data-slot="status-dot"
      data-tone={tone}
      role={ariaLabel ? "img" : undefined}
      title={title}
    />
  );
}

export { StatusDot, statusDotVariants };
