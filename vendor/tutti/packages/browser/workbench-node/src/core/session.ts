import type { BrowserNodeSessionMode } from "./types.ts";

const browserSharedPartition = "persist:browser-node-shared";
const browserIncognitoPartition = "browser-node-incognito";
const browserProfilePartitionPrefix = "persist:browser-node-profile-";

export function resolveBrowserSessionPartition({
  profileId,
  sessionMode,
  sessionPartition
}: BrowserNodeSessionPartitionInput): string {
  const normalizedSessionPartition = sessionPartition?.trim() ?? "";
  if (normalizedSessionPartition.length > 0) {
    return normalizedSessionPartition;
  }

  if (sessionMode === "incognito") {
    return browserIncognitoPartition;
  }

  const normalizedProfileId = profileId?.trim() ?? "";
  if (sessionMode === "profile" && normalizedProfileId.length > 0) {
    return `${browserProfilePartitionPrefix}${normalizedProfileId}`;
  }

  return browserSharedPartition;
}

export interface BrowserNodeSessionPartitionInput {
  profileId: string | null;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition?: string | null;
}

export function isBrowserSessionPartitionAllowed(
  value: string | undefined,
  options: BrowserSessionPartitionAllowedOptions = {}
): boolean {
  const partition = value?.trim() ?? "";
  return (
    partition === browserIncognitoPartition ||
    partition === browserSharedPartition ||
    partition.startsWith(browserProfilePartitionPrefix) ||
    options.additionalAllowedPrefixes?.some((prefix) =>
      partition.startsWith(prefix)
    ) === true
  );
}

export interface BrowserSessionPartitionAllowedOptions {
  additionalAllowedPrefixes?: readonly string[];
}
