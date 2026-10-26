const TEXTAREA_MIRROR_STYLE_PROPERTIES = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderRadius",
  "fontFamily",
  "fontFeatureSettings",
  "fontKerning",
  "fontOpticalSizing",
  "fontSize",
  "fontStretch",
  "fontStyle",
  "fontVariant",
  "fontVariationSettings",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "textAlign",
  "textDecoration",
  "textIndent",
  "textTransform",
  "wordBreak",
  "overflowWrap",
  "tabSize",
  "MozTabSize"
] as const;

export interface TextareaCaretViewportPoint {
  x: number;
  y: number;
  lineHeight: number;
}

function parsePixelValue(value: string | null | undefined): number | null {
  if (!value || value === "normal") {
    return null;
  }

  const parsedValue = Number.parseFloat(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function resolveLineHeight(computedStyle: CSSStyleDeclaration): number {
  const explicitLineHeight = parsePixelValue(computedStyle.lineHeight);
  if (explicitLineHeight !== null) {
    return explicitLineHeight;
  }

  const fontSize = parsePixelValue(computedStyle.fontSize);
  return fontSize !== null ? fontSize * 1.4 : 20;
}

export function getTextareaCaretViewportPoint(
  textarea: HTMLTextAreaElement,
  selectionStart: number
): TextareaCaretViewportPoint | null {
  if (typeof document === "undefined") {
    return null;
  }

  const safeSelectionStart = Math.max(
    0,
    Math.min(selectionStart, textarea.value.length)
  );
  const textareaRect = textarea.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const marker = document.createElement("span");

  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "fixed";
  mirror.style.left = `${textareaRect.left}px`;
  mirror.style.top = `${textareaRect.top}px`;
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.overflow = "hidden";

  for (const propertyName of TEXTAREA_MIRROR_STYLE_PROPERTIES) {
    (mirror.style as CSSStyleDeclaration & Record<string, string>)[
      propertyName
    ] =
      (
        computedStyle as CSSStyleDeclaration &
          Record<string, string | undefined>
      )[propertyName] ?? "";
  }
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = computedStyle.wordBreak;
  mirror.style.overflowWrap = computedStyle.overflowWrap;

  const preSelectionText = textarea.value.slice(0, safeSelectionStart);
  mirror.textContent = preSelectionText.length > 0 ? preSelectionText : "";
  if (preSelectionText.endsWith("\n")) {
    mirror.append(document.createTextNode("\u200b"));
  }

  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);

  try {
    const markerRect = marker.getBoundingClientRect();
    const lineHeight = resolveLineHeight(computedStyle);

    return {
      x: markerRect.left - textarea.scrollLeft,
      y: markerRect.top - textarea.scrollTop,
      lineHeight
    };
  } finally {
    mirror.remove();
  }
}
