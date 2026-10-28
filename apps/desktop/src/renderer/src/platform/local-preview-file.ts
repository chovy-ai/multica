import type { LocalConversationClient, LocalConversationScope, LocalPreviewFile } from "@multica/core/local-conversation/protocol";

const TEXT_LIMIT = 1024 * 1024;

/**
 * Fills a preview's content from its file grant: images and PDFs load by URL
 * over the host's file endpoint; text is fetched and shown up to 1 MB.
 */
export async function hydratePreviewFile(client: Pick<LocalConversationClient, "files">, scope: LocalConversationScope, file: LocalPreviewFile): Promise<LocalPreviewFile> {
  if (!file.fileRef) return file;
  if (file.mimeType.startsWith("image/") || file.mimeType === "application/pdf") return { ...file, url: client.files.url(scope, file.fileRef) };
  const bytes = new Uint8Array(await (await client.files.read(scope, file.fileRef)).arrayBuffer());
  return { ...file, text: new TextDecoder().decode(bytes.subarray(0, TEXT_LIMIT)), truncated: bytes.length > TEXT_LIMIT };
}

/** The agent GUI frame's existing contract carries file bytes as base64. */
export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(binary);
}
