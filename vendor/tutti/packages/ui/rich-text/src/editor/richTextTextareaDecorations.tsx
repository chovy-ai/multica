import type { CSSProperties, JSX, PointerEvent } from "react";
import { MentionPill } from "@tutti-os/ui-system/components";
import { cn } from "@tutti-os/ui-system/utils";
import type { RichTextTextareaDecorationSegment } from "./richTextTextareaDecorationModel.ts";

const richTextWorkspaceReferencePillClassName = "max-w-[18rem]";

export function RichTextTextareaDecoratedContent({
  onClickSegment,
  onRemoveSegment,
  removeActionAriaLabel,
  scrollLeft,
  scrollTop,
  segments,
  textareaStyle
}: {
  onClickSegment: (
    segment: Extract<RichTextTextareaDecorationSegment, { type: "link" }>,
    event: PointerEvent<HTMLSpanElement>
  ) => void;
  onRemoveSegment: (
    segment: Extract<RichTextTextareaDecorationSegment, { type: "link" }>
  ) => void;
  removeActionAriaLabel?: string;
  scrollLeft: number;
  scrollTop: number;
  segments: readonly RichTextTextareaDecorationSegment[];
  textareaStyle: CSSProperties;
}): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <div
        className="min-h-full min-w-full"
        style={{
          ...textareaStyle,
          transform: `translate(${-scrollLeft}px, ${-scrollTop}px)`
        }}
      >
        {segments.map((segment, index) => {
          if (segment.type === "text") {
            return <span key={index}>{segment.text}</span>;
          }

          return (
            <span key={index} className="relative">
              <span aria-hidden="true" className="text-transparent">
                {segment.text}
              </span>
              <MentionPill
                className={cn(
                  "pointer-events-auto absolute inset-y-0 left-0 pr-1 pl-1.5",
                  richTextWorkspaceReferencePillClassName
                )}
                fileKind={segment.kind}
                kind="file"
                label={segment.label}
                removeButtonProps={{
                  "aria-label": removeActionAriaLabel,
                  onPointerDown: (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onRemoveSegment(segment);
                  }
                }}
                summary={
                  <span
                    className={cn(
                      "min-w-0 truncate text-[11px] text-current opacity-80",
                      segment.kind === "folder"
                        ? "max-w-[18rem]"
                        : "max-w-[20rem]"
                    )}
                  >
                    {segment.href}
                  </span>
                }
                onPointerDown={(event) => {
                  onClickSegment(segment, event);
                }}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}
