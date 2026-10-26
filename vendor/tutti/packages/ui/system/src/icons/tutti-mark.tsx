import type { IconProps } from "./types";

export function TuttiMark({
  className,
  size = 28,
  title,
  ...props
}: IconProps) {
  const dimension = typeof size === "number" ? `${size}` : size;

  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={className}
      fill="none"
      height={dimension}
      viewBox="0 0 28 28"
      width={dimension}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <rect
        fill="var(--panel)"
        height="27"
        rx="13.5"
        width="27"
        x="0.5"
        y="0.5"
      />
      <path
        d="M8.5 18.4V9.6H11.1L16.5 16.35V9.6H19.5V18.4H16.95L11.5 11.58V18.4H8.5Z"
        fill="currentColor"
      />
      <path
        d="M19.48 8.55L21.6 6.44L21.57 11.12L16.9 11.08L19.48 8.55Z"
        fill="var(--primary)"
      />
    </svg>
  );
}
