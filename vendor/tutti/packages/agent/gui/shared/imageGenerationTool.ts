interface ImageGenerationProbe {
  toolName?: string | null;
  displayName?: string | null;
  outputSavedPath?: unknown;
  outputSavedPaths?: unknown;
  outputMimeType?: unknown;
  outputText?: unknown;
  inputPrompt?: unknown;
  payloadInputPrompt?: unknown;
}

export interface ImageGenerationPreview {
  prompt: string | null;
  imageUri: string | null;
  mimeType: string | null;
}

const KNOWN_IMAGE_GENERATION_TOOL_NAMES = new Set([
  "imagegeneration",
  "imagegen",
  "generateimage",
  "generatingimage",
  "imagegenerate",
  "imagegenerator"
]);

export function resolveImageGenerationCanonicalToolName(
  probe: ImageGenerationProbe
): "ImageGeneration" | null {
  return isImageGenerationToolCall(probe) ? "ImageGeneration" : null;
}

export function isImageGenerationToolCall(
  probe: ImageGenerationProbe
): boolean {
  const normalizedToolName = normalizeToolNameToken(probe.toolName);
  const normalizedDisplayName = normalizeToolNameToken(probe.displayName);
  const preview = extractImageGenerationPreview(probe);
  const hasKnownName =
    KNOWN_IMAGE_GENERATION_TOOL_NAMES.has(normalizedToolName) ||
    KNOWN_IMAGE_GENERATION_TOOL_NAMES.has(normalizedDisplayName);
  const hasOpaqueAlias =
    looksLikeOpaqueImageGenerationAlias(probe.toolName) ||
    looksLikeOpaqueImageGenerationAlias(probe.displayName);
  const hasPromptSignal = Boolean(
    preview.prompt &&
    (preview.prompt.toLowerCase().startsWith("revised prompt:") ||
      stringValue(probe.inputPrompt) ||
      stringValue(probe.payloadInputPrompt))
  );

  return (
    hasKnownName ||
    (hasOpaqueAlias && preview.imageUri !== null) ||
    (hasPromptSignal && preview.imageUri !== null)
  );
}

export function extractImageGenerationPreview(
  probe: ImageGenerationProbe
): ImageGenerationPreview {
  const prompt =
    firstString(
      stringValue(probe.inputPrompt),
      stringValue(probe.payloadInputPrompt),
      stringValue(probe.outputText)
    ) ?? null;
  const savedPaths = Array.isArray(probe.outputSavedPaths)
    ? probe.outputSavedPaths.flatMap((value) => {
        const path = stringValue(value);
        return path ? [path] : [];
      })
    : [];

  return {
    prompt,
    imageUri:
      firstString(stringValue(probe.outputSavedPath), savedPaths[0]) ?? null,
    mimeType: stringValue(probe.outputMimeType)
  };
}

export function stripImagePayloadData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripImagePayloadData(item));
  }
  const record = recordValue(value);
  if (!record) {
    return value;
  }
  const imageLike = looksLikeImageRecord(record);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = key.trim().toLowerCase();
    if (imageLike && normalizedKey === "data") {
      continue;
    }
    if (
      imageLike &&
      (normalizedKey === "uri" || normalizedKey === "path") &&
      typeof entry === "string" &&
      entry.trim().toLowerCase().startsWith("data:image/")
    ) {
      continue;
    }
    sanitized[key] = stripImagePayloadData(entry);
  }
  return sanitized;
}

// A bare local filesystem path (posix absolute or Windows drive letter), as
// opposed to a scheme-qualified URL. Shared by the generated-image preview and
// the conversation copy serializer so both hydrate the same source taxonomy
// through the host workspace reader.
export function isLocalImagePath(path: string): boolean {
  const candidate = path.trim();
  return (
    (candidate.length > 1 &&
      candidate.startsWith("/") &&
      !candidate.startsWith("//") &&
      !candidate.includes("://") &&
      !/\s/.test(candidate)) ||
    /^[a-zA-Z]:[\\/]/.test(candidate)
  );
}

export function resolveImageGenerationPreviewSrc(
  uri: string | null
): string | null {
  const trimmed = uri?.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return new URL(trimmed, "file://").toString();
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return `file:///${trimmed.replace(/\\/g, "/")}`;
  }
  return trimmed;
}

function looksLikeImageRecord(value: Record<string, unknown>): boolean {
  const type = stringValue(value.type)?.toLowerCase();
  const mimeType = stringValue(value.mimeType)?.toLowerCase();
  const uri = firstString(stringValue(value.uri), stringValue(value.path));
  return (
    type === "image" ||
    Boolean(mimeType?.startsWith("image/")) ||
    Boolean(uri && value.data)
  );
}

function looksLikeOpaqueImageGenerationAlias(
  value: string | null | undefined
): boolean {
  return /^ig_[a-z0-9]+$/i.test((value ?? "").trim());
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (value?.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeToolNameToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/gu, "");
}
