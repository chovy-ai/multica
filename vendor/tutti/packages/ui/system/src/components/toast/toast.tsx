import * as React from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import {
  CloseIcon,
  FailedFilledIcon,
  SuccessFilledIcon
} from "#icons/system-icons";
import { Spinner } from "../spinner";
import { cn } from "#lib/utils";

const toastDefaultDurationMs = 3000;

function ToastProvider({
  duration = toastDefaultDurationMs,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider duration={duration} {...props} />;
}

const ToastVisualContext = React.createContext<{
  busy: boolean;
  variant: VariantProps<typeof toastVariants>["variant"];
} | null>(null);

type ToastStatusIconVariant = "destructive" | "success";

const toastStatusIconByVariant = {
  destructive: FailedFilledIcon,
  success: SuccessFilledIcon
} satisfies Record<
  ToastStatusIconVariant,
  React.ComponentType<{ className?: string }>
>;

function hasToastStatusIcon(
  variant: VariantProps<typeof toastVariants>["variant"]
): variant is ToastStatusIconVariant {
  return variant === "destructive" || variant === "success";
}

function stripToastTrailingSentencePunctuation(value: string): string {
  let nextValue = value.replace(/\s+$/u, "");
  while (nextValue.length > 0) {
    const last = nextValue.at(-1);
    if (last === "." || last === "。" || last === "．") {
      nextValue = nextValue.slice(0, -1).replace(/\s+$/u, "");
    } else {
      break;
    }
  }
  return nextValue;
}

function formatToastText(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    return stripToastTrailingSentencePunctuation(children);
  }
  const flatChildren = React.Children.toArray(children);
  if (flatChildren.length === 1 && typeof flatChildren[0] === "string") {
    return stripToastTrailingSentencePunctuation(flatChildren[0]);
  }
  return children;
}

const toastVariants = cva(
  "group pointer-events-auto relative flex min-h-8 min-w-0 max-w-[min(92vw,420px)] items-center justify-center rounded-[8px] px-3 py-1.5 text-center text-[13px] font-normal leading-normal shadow-none transition-all data-closed:fade-out-80 data-closed:slide-out-to-top-full data-open:slide-in-from-top-full data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
  {
    variants: {
      variant: {
        default:
          "border border-[var(--toast-neutral-border)] bg-[var(--toast-neutral-bg)] text-[var(--toast-neutral-fg)]",
        destructive:
          "border-0 bg-[var(--state-danger)] text-[var(--white-stationary)]",
        success:
          "border-0 bg-[var(--state-success)] text-[var(--text-inverted)]"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

function ToastRoot({
  className,
  variant,
  busy = false,
  anchor = "viewport",
  nodeInsetTopPx = 16,
  children,
  style,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> &
  VariantProps<typeof toastVariants> & {
    busy?: boolean;
    anchor?: "viewport" | "node";
    nodeInsetTopPx?: number;
  }) {
  const isDestructive = variant === "destructive";
  return (
    <ToastPrimitive.Root
      aria-busy={busy}
      aria-live={isDestructive ? "assertive" : "polite"}
      data-slot="toast"
      className={cn(
        toastVariants({ variant }),
        anchor === "node" && "absolute left-1/2 -translate-x-1/2",
        className
      )}
      role={isDestructive ? "alert" : "status"}
      style={{
        ...(anchor === "node" ? { top: `${nodeInsetTopPx}px` } : {}),
        ...style
      }}
      {...props}
    >
      <ToastVisualContext.Provider value={{ busy, variant }}>
        <span className="flex min-w-0 max-w-full flex-col items-center justify-center whitespace-normal break-words text-center">
          {children}
        </span>
      </ToastVisualContext.Provider>
    </ToastPrimitive.Root>
  );
}

function ToastTitle({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Title>) {
  const toastVisual = React.useContext(ToastVisualContext);
  const StatusIcon =
    toastVisual?.variant && hasToastStatusIcon(toastVisual.variant)
      ? toastStatusIconByVariant[toastVisual.variant]
      : null;

  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn(
        "inline-flex max-w-full items-center justify-center gap-[6px] text-center text-[13px] font-normal leading-normal",
        className
      )}
      {...props}
    >
      {toastVisual?.busy ? (
        <Spinner
          className="shrink-0 text-current"
          size={16}
          strokeWidth={2}
          trackColor="color-mix(in srgb, currentColor 28%, transparent)"
        />
      ) : StatusIcon ? (
        <StatusIcon className="size-4 shrink-0 text-current" />
      ) : null}
      <span className="min-w-0 break-words">{formatToastText(children)}</span>
    </ToastPrimitive.Title>
  );
}

function ToastDescription({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn(
        "box-border w-full px-2 text-[11px] font-normal leading-[1.3] text-current opacity-75 [overflow-wrap:anywhere]",
        className
      )}
      {...props}
    />
  );
}

function ToastClose({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        "absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-[4px] text-current opacity-65 transition-[background-color,opacity] hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,currentColor_28%,transparent)]",
        className
      )}
      {...props}
    >
      <CloseIcon className="size-4" />
    </ToastPrimitive.Close>
  );
}

function ToastViewport({
  className,
  style,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "fixed left-1/2 top-3 flex max-h-screen w-auto -translate-x-1/2 flex-col items-center gap-2 p-0",
        className
      )}
      style={{ zIndex: "var(--z-toast)", ...style }}
      {...props}
    />
  );
}

export {
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastViewport,
  toastVariants
};
