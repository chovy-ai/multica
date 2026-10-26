import * as React from "react";

import { Button } from "#components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "#components/dialog";
import { cn } from "#lib/utils";

type ConfirmationDialogTone = "default" | "destructive";

function confirmToneClassName(tone: ConfirmationDialogTone) {
  if (tone === "destructive") {
    return "shadow-none";
  }

  return undefined;
}

function ConfirmationDialog({
  cancelLabel,
  children,
  className,
  confirmBusy = false,
  confirmDisabled = false,
  confirmLabel,
  description,
  disableCloseWhileBusy = true,
  footer,
  hideConfirmButton = false,
  onCancel,
  onConfirm,
  onOpenChange,
  open,
  overlayClassName,
  portaled = true,
  tone = "default",
  title
}: {
  cancelLabel: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  confirmBusy?: boolean;
  confirmDisabled?: boolean;
  confirmLabel: React.ReactNode;
  description?: React.ReactNode;
  disableCloseWhileBusy?: boolean;
  footer?: React.ReactNode;
  hideConfirmButton?: boolean;
  onCancel?: () => void;
  onConfirm?: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  overlayClassName?: string;
  portaled?: boolean;
  tone?: ConfirmationDialogTone;
  title: React.ReactNode;
}) {
  const isCloseDisabled = disableCloseWhileBusy && confirmBusy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-w-[calc(100%-2rem)] text-left sm:max-w-[360px]",
          className
        )}
        overlayClassName={cn(overlayClassName)}
        portaled={portaled}
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (isCloseDisabled) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isCloseDisabled) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children ? (
          <div className="text-[13px] leading-[1.3] text-text-secondary">
            {children}
          </div>
        ) : null}
        {footer ?? (
          <DialogFooter>
            <Button
              disabled={confirmBusy}
              size="dialog"
              type="button"
              variant="ghost"
              onClick={() => {
                onCancel?.();
                onOpenChange(false);
              }}
            >
              {cancelLabel}
            </Button>
            {hideConfirmButton ? null : (
              <Button
                disabled={confirmBusy || confirmDisabled}
                size="dialog"
                type="button"
                variant={tone === "default" ? "default" : "destructive"}
                className={cn("shadow-none", confirmToneClassName(tone))}
                onClick={() => {
                  onConfirm?.();
                }}
              >
                {confirmLabel}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmationDialog };
export type { ConfirmationDialogTone };
