import { useComposedInputValue } from "@tutti-os/ui-react-hooks";
import { Input } from "@tutti-os/ui-system";
import { type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CloseLinedIcon } from "../../app/renderer/components/icons/CloseLinedIcon";
import { useTranslation } from "../../i18n/index";

import styles from "./RoomIssueNode.styles";

interface TaskSearchFieldProps {
  ariaLabel?: string;
  className?: string;
  clearAriaLabel?: string;
  dataTestId?: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder: string;
  value: string;
}

export function TaskSearchField({
  ariaLabel,
  className,
  clearAriaLabel,
  dataTestId,
  onChange,
  onSubmit,
  placeholder,
  value
}: TaskSearchFieldProps) {
  "use memo";
  const { t } = useTranslation();
  const searchInput = useComposedInputValue({ onCommit: onChange, value });

  return (
    <div
      className={`${styles.searchField} ${className ?? ""}`.trim()}
      data-has-value={searchInput.value ? "true" : "false"}
    >
      <Input
        type="search"
        value={searchInput.value}
        onBlur={searchInput.onBlur}
        onChange={searchInput.onChange}
        onCompositionEnd={searchInput.onCompositionEnd}
        onCompositionStart={searchInput.onCompositionStart}
        onKeyDown={(event) => {
          if (isTaskSearchImeComposing(event)) {
            return;
          }
          if (event.key === "Enter") {
            onSubmit?.();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={styles.searchInput}
        data-testid={dataTestId}
      />
      {searchInput.value ? (
        <button
          type="button"
          className={styles.searchClearButton}
          aria-label={clearAriaLabel ?? t("common.clear")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={searchInput.clearValue}
        >
          <CloseLinedIcon aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function isTaskSearchImeComposing(
  event: ReactKeyboardEvent<HTMLInputElement>
): boolean {
  const eventWithFallbacks = event as ReactKeyboardEvent<HTMLInputElement> & {
    keyCode?: number;
    nativeEvent?: KeyboardEvent & {
      keyCode?: number;
      which?: number;
    };
    which?: number;
  };

  if (event.nativeEvent.isComposing) {
    return true;
  }

  const keyCode =
    eventWithFallbacks.keyCode ?? eventWithFallbacks.nativeEvent?.keyCode;
  const which =
    eventWithFallbacks.which ?? eventWithFallbacks.nativeEvent?.which;
  return keyCode === 229 || which === 229;
}
