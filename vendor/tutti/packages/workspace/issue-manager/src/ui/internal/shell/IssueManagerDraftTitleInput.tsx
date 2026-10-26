import { useComposedInputValue } from "@tutti-os/ui-react-hooks";
import { useLayoutEffect, useRef, type JSX } from "react";
import { Input } from "@tutti-os/ui-system";

export function IssueManagerDraftTitleInput({
  onChange,
  placeholder,
  value
}: {
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectionRef = useRef<{
    direction: "backward" | "forward" | "none";
    end: number;
    start: number;
  } | null>(null);
  const titleInput = useComposedInputValue({ onCommit: onChange, value });

  useLayoutEffect(() => {
    const input = inputRef.current;
    const selection = pendingSelectionRef.current;
    if (!input || !selection || document.activeElement !== input) {
      return;
    }
    pendingSelectionRef.current = null;
    const maxPosition = input.value.length;
    input.setSelectionRange(
      Math.min(selection.start, maxPosition),
      Math.min(selection.end, maxPosition),
      selection.direction
    );
  }, [titleInput.value, value]);

  const rememberSelection = (input: HTMLInputElement) => {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === null || end === null) {
      return;
    }
    pendingSelectionRef.current = {
      direction: input.selectionDirection ?? "none",
      end,
      start
    };
  };

  return (
    <Input
      ref={inputRef}
      placeholder={placeholder}
      variant="md"
      value={titleInput.value}
      onBlur={titleInput.onBlur}
      onChange={(event) => {
        rememberSelection(event.currentTarget);
        titleInput.onChange(event);
      }}
      onCompositionEnd={(event) => {
        rememberSelection(event.currentTarget);
        titleInput.onCompositionEnd(event);
      }}
      onCompositionStart={titleInput.onCompositionStart}
    />
  );
}
