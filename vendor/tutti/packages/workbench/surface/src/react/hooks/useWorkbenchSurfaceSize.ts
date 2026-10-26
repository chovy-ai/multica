import { useLayoutEffect, useRef, type RefObject } from "react";
import type { WorkbenchSize } from "../../core/types.ts";

export function useWorkbenchSurfaceSize<TElement extends HTMLElement>(
  onSizeChange: (size: WorkbenchSize) => void
): RefObject<TElement | null> {
  const ref = useRef<TElement | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const publish = () => {
      const rect = element.getBoundingClientRect();
      onSizeChange({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height))
      });
    };

    publish();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", publish);
      return () => {
        window.removeEventListener("resize", publish);
      };
    }

    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [onSizeChange]);

  return ref;
}
