import type { JSX, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ArrowLeftIcon, ArrowRightIcon } from "#icons/system-icons";
import { cn } from "#lib/utils";

export interface UnderlineTabItem<TValue extends string> {
  value: TValue;
  label: ReactNode;
  count?: ReactNode;
  testId?: string;
}

interface UnderlineTabsProps<TValue extends string> {
  tabs: ReadonlyArray<UnderlineTabItem<TValue>>;
  value: TValue;
  onValueChange: (value: TValue) => void;
  ariaLabel?: string;
  className?: string;
  testId?: string;
  viewportTestId?: string;
  scrollLeftLabel?: string;
  scrollRightLabel?: string;
  scrollLeftTestId?: string;
  scrollRightTestId?: string;
  preventMouseDownDefault?: boolean;
}

function UnderlineTabs<TValue extends string>({
  tabs,
  value,
  onValueChange,
  ariaLabel,
  className,
  testId,
  viewportTestId,
  scrollLeftLabel = "Scroll left",
  scrollRightLabel = "Scroll right",
  scrollLeftTestId,
  scrollRightTestId,
  preventMouseDownDefault = false
}: UnderlineTabsProps<TValue>): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Partial<Record<TValue, HTMLButtonElement>>>({});
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const [overflow, setOverflow] = useState({
    canScrollLeft: false,
    canScrollRight: false
  });

  useLayoutEffect(() => {
    const row = rowRef.current;
    const button = buttonRefs.current[value];
    if (!row || !button) {
      setIndicatorStyle((current) =>
        current.left === 0 && current.width === 0
          ? current
          : { left: 0, width: 0 }
      );
      return;
    }

    const nextStyle = {
      left: button.offsetLeft,
      width: button.offsetWidth
    };

    setIndicatorStyle((current) =>
      current.left === nextStyle.left && current.width === nextStyle.width
        ? current
        : nextStyle
    );
  }, [tabs, value]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const syncOverflow = () => {
      const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
      setOverflow((current) => {
        const next = {
          canScrollLeft: viewport.scrollLeft > 1,
          canScrollRight: viewport.scrollLeft < maxScrollLeft - 1
        };

        return current.canScrollLeft === next.canScrollLeft &&
          current.canScrollRight === next.canScrollRight
          ? current
          : next;
      });
    };

    syncOverflow();
    viewport.addEventListener("scroll", syncOverflow, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncOverflow);
      resizeObserver.observe(viewport);
      if (rowRef.current) {
        resizeObserver.observe(rowRef.current);
      }
    }

    window.addEventListener("resize", syncOverflow);

    return () => {
      viewport.removeEventListener("scroll", syncOverflow);
      window.removeEventListener("resize", syncOverflow);
      resizeObserver?.disconnect();
    };
  }, [tabs]);

  const scrollTabs = (direction: "left" | "right") => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const delta = Math.max(120, viewport.clientWidth * 0.72);
    viewport.scrollBy({
      left: direction === "left" ? -delta : delta,
      behavior: "smooth"
    });
  };

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "group relative box-border h-[33px] min-w-0 border-b border-[var(--border-1)] px-4",
        className
      )}
      data-slot="underline-tabs"
      data-testid={testId}
      role="tablist"
    >
      <div
        ref={viewportRef}
        className={cn(
          "h-8 overflow-x-auto overflow-y-hidden [scrollbar-gutter:stable] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          overflow.canScrollLeft &&
            !overflow.canScrollRight &&
            "[mask-image:linear-gradient(90deg,transparent_0,black_28px,black_100%)] [-webkit-mask-image:linear-gradient(90deg,transparent_0,black_28px,black_100%)]",
          !overflow.canScrollLeft &&
            overflow.canScrollRight &&
            "[mask-image:linear-gradient(90deg,black_0,black_calc(100%_-_28px),transparent_100%)] [-webkit-mask-image:linear-gradient(90deg,black_0,black_calc(100%_-_28px),transparent_100%)]",
          overflow.canScrollLeft &&
            overflow.canScrollRight &&
            "[mask-image:linear-gradient(90deg,transparent_0,black_28px,black_calc(100%_-_28px),transparent_100%)] [-webkit-mask-image:linear-gradient(90deg,transparent_0,black_28px,black_calc(100%_-_28px),transparent_100%)]"
        )}
        data-can-scroll-left={overflow.canScrollLeft ? "true" : "false"}
        data-can-scroll-right={overflow.canScrollRight ? "true" : "false"}
        data-slot="underline-tabs-viewport"
        data-testid={viewportTestId}
      >
        <div
          ref={rowRef}
          className="relative flex h-8 w-max min-w-full items-center gap-[14px] pb-2"
        >
          {tabs.map((tab) => {
            const isActive = value === tab.value;
            return (
              <button
                key={tab.value}
                ref={(element) => {
                  if (element) {
                    buttonRefs.current[tab.value] = element;
                  } else {
                    delete buttonRefs.current[tab.value];
                  }
                }}
                aria-selected={isActive}
                className={cn(
                  "relative inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap border-0 bg-transparent p-0 text-[13px] font-medium leading-6 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none",
                  isActive && "text-[var(--tutti-purple)]"
                )}
                data-active={isActive ? "true" : "false"}
                data-slot="underline-tabs-tab"
                data-testid={tab.testId}
                role="tab"
                type="button"
                onClick={() => onValueChange(tab.value)}
                onMouseDown={
                  preventMouseDownDefault
                    ? (event) => event.preventDefault()
                    : undefined
                }
              >
                <span>{tab.label}</span>
                {tab.count !== undefined ? (
                  <span className="text-[11px] font-medium leading-6 text-[inherit]">
                    {tab.count}
                  </span>
                ) : null}
              </button>
            );
          })}
          <div
            aria-hidden
            className="absolute bottom-0 left-0 z-[1] h-0.5 rounded-[1px] bg-[var(--tutti-purple)] transition-[transform,width] duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none"
            data-slot="underline-tabs-indicator"
            style={{
              transform: `translateX(${indicatorStyle.left}px)`,
              width: indicatorStyle.width
            }}
          />
        </div>
      </div>
      <button
        aria-label={scrollLeftLabel}
        className="pointer-events-none absolute left-4 top-3 z-[3] inline-flex size-6 translate-y-[-50%] scale-[0.94] items-center justify-center rounded-full border-0 bg-[var(--background-fronted)] p-0 text-[var(--text-secondary)] opacity-0 shadow-[0_4px_16px_rgba(15,23,42,0.12)] transition-[opacity,transform,background-color,color] duration-[160ms] ease-in-out hover:bg-[var(--background-fronted)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--background-fronted)] focus-visible:text-[var(--text-primary)] group-hover:data-[visible=true]:pointer-events-auto group-hover:data-[visible=true]:scale-100 group-hover:data-[visible=true]:opacity-100 group-focus-within:data-[visible=true]:pointer-events-auto group-focus-within:data-[visible=true]:scale-100 group-focus-within:data-[visible=true]:opacity-100 disabled:pointer-events-none"
        data-slot="underline-tabs-scroll-left"
        data-testid={scrollLeftTestId}
        data-visible={overflow.canScrollLeft ? "true" : "false"}
        disabled={!overflow.canScrollLeft}
        type="button"
        onClick={() => scrollTabs("left")}
      >
        <ArrowLeftIcon size={16} />
      </button>
      <button
        aria-label={scrollRightLabel}
        className="pointer-events-none absolute right-4 top-3 z-[3] inline-flex size-6 translate-y-[-50%] scale-[0.94] items-center justify-center rounded-full border-0 bg-[var(--background-fronted)] p-0 text-[var(--text-secondary)] opacity-0 shadow-[0_4px_16px_rgba(15,23,42,0.12)] transition-[opacity,transform,background-color,color] duration-[160ms] ease-in-out hover:bg-[var(--background-fronted)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--background-fronted)] focus-visible:text-[var(--text-primary)] group-hover:data-[visible=true]:pointer-events-auto group-hover:data-[visible=true]:scale-100 group-hover:data-[visible=true]:opacity-100 group-focus-within:data-[visible=true]:pointer-events-auto group-focus-within:data-[visible=true]:scale-100 group-focus-within:data-[visible=true]:opacity-100 disabled:pointer-events-none"
        data-slot="underline-tabs-scroll-right"
        data-testid={scrollRightTestId}
        data-visible={overflow.canScrollRight ? "true" : "false"}
        disabled={!overflow.canScrollRight}
        type="button"
        onClick={() => scrollTabs("right")}
      >
        <ArrowRightIcon size={16} />
      </button>
    </div>
  );
}

export { UnderlineTabs };
