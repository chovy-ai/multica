export interface RichTextImeKeyboardEventLike {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
  which?: number;
}

export function isRichTextImeComposing(
  event: RichTextImeKeyboardEventLike
): boolean {
  if (event.isComposing || event.nativeEvent?.isComposing) {
    return true;
  }

  const keyCode = event.keyCode ?? event.nativeEvent?.keyCode;
  const which = event.which ?? event.nativeEvent?.which;
  return keyCode === 229 || which === 229;
}
