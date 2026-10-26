import type { CSSProperties, JSX } from "react";

import { LoadingIcon } from "#icons/system-icons";
import { cn } from "#lib/utils";

export interface SpinnerProps {
  className?: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  testId?: string;
  trackColor?: string;
}

function Spinner({
  className,
  size = 16,
  strokeWidth = 2,
  style,
  testId,
  trackColor
}: SpinnerProps): JSX.Element {
  return (
    <LoadingIcon
      data-slot="spinner"
      data-testid={testId}
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 animate-spin text-primary",
        className
      )}
      size={size}
      style={style}
      strokeWidth={strokeWidth}
      trackColor={trackColor}
    />
  );
}

export { Spinner };
