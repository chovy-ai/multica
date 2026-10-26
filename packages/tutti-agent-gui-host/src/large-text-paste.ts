const MAX_INLINE_PASTE_LINES = 1000;

export function shouldStagePastedText(text: string, minimumCharacters = 5000): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length >= minimumCharacters) return true;

  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    const character = text.charCodeAt(index);
    if (character !== 10 && character !== 13) continue;
    if (++lines > MAX_INLINE_PASTE_LINES) return true;
    if (character === 13 && text.charCodeAt(index + 1) === 10) index++;
  }
  return false;
}
