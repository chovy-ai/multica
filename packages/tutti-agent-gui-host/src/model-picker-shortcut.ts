/** Give the focused model panel first refusal of the shared digit shortcuts. */
export function activateModelPickerShortcut(key: number): boolean {
  if (!Number.isInteger(key) || key < 1 || key > 4 || !document.hasFocus())
    return false;
  const panel = document.activeElement?.closest(
    "[data-model-picker-shortcuts]"
  );
  if (!panel) return false;
  panel
    .querySelector<HTMLInputElement>(`input[data-model-shortcut="${key}"]`)
    ?.click();
  // Missing or disabled choices still belong to the open panel, not a tab.
  return true;
}
