import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent
} from "react";

export interface ComposedInputPendingCommit {
  committedValue: string;
  previousValue: string;
}

export interface ComposedInputValueSyncInput {
  isComposing: boolean;
  localValue: string;
  pendingCommit: ComposedInputPendingCommit | null;
  value: string;
}

export interface ComposedInputValueSyncResult {
  pendingCommit: ComposedInputPendingCommit | null;
  shouldSyncLocalValue: boolean;
  value: string;
}

export interface UseComposedInputValueInput {
  onCommit: (value: string) => void;
  value: string;
}

export interface UseComposedInputValueResult {
  clearValue: () => void;
  commitValue: (value: string) => void;
  isComposing: boolean;
  onBlur: (event: FocusEvent<HTMLInputElement>) => void;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
  onCompositionStart: () => void;
  value: string;
}

export function resolveComposedInputValueSync(
  input: ComposedInputValueSyncInput
): ComposedInputValueSyncResult {
  if (input.isComposing) {
    return {
      pendingCommit: input.pendingCommit,
      shouldSyncLocalValue: false,
      value: input.localValue
    };
  }

  if (input.pendingCommit !== null) {
    if (input.value === input.pendingCommit.committedValue) {
      return {
        pendingCommit: null,
        shouldSyncLocalValue: input.localValue !== input.value,
        value: input.value
      };
    }

    if (
      input.localValue === input.pendingCommit.committedValue &&
      input.value === input.pendingCommit.previousValue
    ) {
      return {
        pendingCommit: input.pendingCommit,
        shouldSyncLocalValue: false,
        value: input.localValue
      };
    }
  }

  return {
    pendingCommit: null,
    shouldSyncLocalValue: input.localValue !== input.value,
    value: input.value
  };
}

export function useComposedInputValue({
  onCommit,
  value
}: UseComposedInputValueInput): UseComposedInputValueResult {
  const pendingCommitRef = useRef<ComposedInputPendingCommit | null>(null);
  const isComposingRef = useRef(false);
  const [localValue, setLocalValue] = useState(value);
  const [isComposing, setIsComposing] = useState(false);

  useEffect(() => {
    const syncResult = resolveComposedInputValueSync({
      isComposing,
      localValue,
      pendingCommit: pendingCommitRef.current,
      value
    });

    pendingCommitRef.current = syncResult.pendingCommit;
    if (syncResult.shouldSyncLocalValue) {
      setLocalValue(syncResult.value);
    }
  }, [isComposing, localValue, value]);

  const commitValue = (nextValue: string) => {
    pendingCommitRef.current = {
      committedValue: nextValue,
      previousValue: value
    };
    setLocalValue(nextValue);
    onCommit(nextValue);
  };

  return {
    clearValue: () => {
      commitValue("");
    },
    commitValue,
    isComposing,
    onBlur: (event: FocusEvent<HTMLInputElement>) => {
      commitValue(event.currentTarget.value);
    },
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.currentTarget.value;
      if (!isComposingRef.current) {
        commitValue(nextValue);
        return;
      }
      setLocalValue(nextValue);
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => {
      isComposingRef.current = false;
      setIsComposing(false);
      commitValue(event.currentTarget.value);
    },
    onCompositionStart: () => {
      isComposingRef.current = true;
      setIsComposing(true);
    },
    value: localValue
  };
}
