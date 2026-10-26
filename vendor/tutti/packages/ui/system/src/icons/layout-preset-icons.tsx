import type { IconProps } from "./types";

type LayoutPresetIconVariant = "balanced" | "row" | "column";

export interface LayoutPresetIconProps extends IconProps {
  selectedCount?: number;
  variant: LayoutPresetIconVariant;
}

export function LayoutPresetIcon({
  className,
  selectedCount = 0,
  size = 24,
  title,
  variant,
  ...props
}: LayoutPresetIconProps) {
  const dimension = typeof size === "number" ? `${size}` : size;

  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={className}
      fill="none"
      height={dimension}
      viewBox="0 0 24 24"
      width={dimension}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <LayoutPresetFrame />
      {variant === "balanced" ? (
        <BalancedLayoutPresetGlyph selectedCount={selectedCount} />
      ) : null}
      {variant === "row" ? <RowLayoutPresetGlyph /> : null}
      {variant === "column" ? <ColumnLayoutPresetGlyph /> : null}
    </svg>
  );
}

function LayoutPresetFrame() {
  return (
    <>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4"
        fill="currentColor"
        opacity="0.12"
      />
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </>
  );
}

function BalancedLayoutPresetGlyph({
  selectedCount
}: {
  selectedCount: number;
}) {
  if (selectedCount <= 2) {
    return (
      <>
        <rect
          x="5.5"
          y="5.5"
          width="6.4"
          height="13"
          rx="1.4"
          fill="currentColor"
        />
        <rect
          x="12.8"
          y="5.5"
          width="5.7"
          height="13"
          rx="1.4"
          fill="currentColor"
          opacity="0.32"
        />
      </>
    );
  }

  if (selectedCount === 3) {
    return (
      <>
        <rect
          x="5.25"
          y="5.25"
          width="7.2"
          height="13.5"
          rx="1.4"
          fill="currentColor"
        />
        <rect
          x="13.75"
          y="5.25"
          width="5"
          height="6.15"
          rx="1.2"
          fill="currentColor"
          opacity="0.5"
        />
        <rect
          x="13.75"
          y="12.6"
          width="5"
          height="6.15"
          rx="1.2"
          fill="currentColor"
          opacity="0.3"
        />
      </>
    );
  }

  return (
    <>
      <rect
        x="5.25"
        y="5.25"
        width="6"
        height="6"
        rx="1.2"
        fill="currentColor"
      />
      <rect
        x="12.75"
        y="5.25"
        width="6"
        height="6"
        rx="1.2"
        fill="currentColor"
        opacity="0.5"
      />
      <rect
        x="5.25"
        y="12.75"
        width="6"
        height="6"
        rx="1.2"
        fill="currentColor"
        opacity="0.5"
      />
      <rect
        x="12.75"
        y="12.75"
        width="6"
        height="6"
        rx="1.2"
        fill="currentColor"
        opacity="0.3"
      />
    </>
  );
}

function RowLayoutPresetGlyph() {
  return (
    <>
      <rect
        x="5.25"
        y="5.25"
        width="6.2"
        height="13.5"
        rx="1.3"
        fill="currentColor"
      />
      <rect
        x="12.55"
        y="5.25"
        width="6.2"
        height="13.5"
        rx="1.3"
        fill="currentColor"
        opacity="0.34"
      />
    </>
  );
}

function ColumnLayoutPresetGlyph() {
  return (
    <>
      <rect
        x="5.25"
        y="5.25"
        width="13.5"
        height="6.2"
        rx="1.3"
        fill="currentColor"
      />
      <rect
        x="5.25"
        y="12.55"
        width="13.5"
        height="6.2"
        rx="1.3"
        fill="currentColor"
        opacity="0.34"
      />
    </>
  );
}
