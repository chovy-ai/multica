export function isAgentRichTextImeComposing(event: KeyboardEvent): boolean {
  const eventWithFallbacks = event as KeyboardEvent & {
    nativeEvent?: KeyboardEvent & {
      isComposing?: boolean;
      keyCode?: number;
      which?: number;
    };
    keyCode?: number;
    which?: number;
  };

  if (event.isComposing || eventWithFallbacks.nativeEvent?.isComposing) {
    return true;
  }

  const keyCode =
    eventWithFallbacks.keyCode ?? eventWithFallbacks.nativeEvent?.keyCode;
  const which =
    eventWithFallbacks.which ?? eventWithFallbacks.nativeEvent?.which;
  return keyCode === 229 || which === 229;
}
