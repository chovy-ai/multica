import type { JSX, ReactNode } from "react";

import { cn } from "#lib/utils";

export interface SectionTabItem<TValue extends string> {
  value: TValue;
  label: ReactNode;
  count?: ReactNode;
  testId?: string;
}

interface SectionTabsProps<TValue extends string> {
  tabs: ReadonlyArray<SectionTabItem<TValue>>;
  value: TValue;
  onValueChange: (value: TValue) => void;
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

function SectionTabs<TValue extends string>({
  tabs,
  value,
  onValueChange,
  ariaLabel,
  className,
  testId
}: SectionTabsProps<TValue>): JSX.Element {
  return (
    <div
      aria-label={ariaLabel}
      className={cn("flex min-w-0 items-center gap-5", className)}
      data-slot="section-tabs"
      data-testid={testId}
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = value === tab.value;
        return (
          <button
            key={tab.value}
            aria-selected={isActive}
            className={cn(
              "relative inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap border-0 bg-transparent p-0 text-[15px] font-semibold leading-5 tracking-[0] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]",
              isActive && "text-[var(--text-primary)]"
            )}
            data-active={isActive ? "true" : "false"}
            data-slot="section-tabs-tab"
            data-testid={tab.testId}
            role="tab"
            type="button"
            onClick={() => onValueChange(tab.value)}
          >
            <span className="min-w-0 truncate">{tab.label}</span>
            {tab.count !== undefined ? (
              <span className="text-[15px] font-semibold leading-5 text-[inherit]">
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export { SectionTabs };
