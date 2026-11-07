import { z } from "zod";

export const CONVERSATION_RESOURCES_CAPABILITY = "conversation-resources-v1";
const count = z.number().int().nonnegative().nullable();
export const conversationFileResourceSchema = z.object({
  id: z.string().min(1), cwd: z.string(), path: z.string().min(1), old_path: z.string().optional(),
  kind: z.string(), reason: z.string().optional().default(""), added: count, deleted: count,
  changed: z.boolean(), initial_exists: z.boolean(), current_exists: z.boolean(), turn_id: z.string(),
});
export const conversationResourceAttachmentSchema = z.object({
  id: z.string().min(1), name: z.string(), media_type: z.string(), size: z.number().nonnegative(), source: z.string(),
});
export const conversationResourcesSchema = z.object({
  revision: z.number().int().nonnegative(), coverage: z.string(), reason: z.string().default(""), recorded_from: z.string(),
  files: z.array(conversationFileResourceSchema), attachments: z.array(conversationResourceAttachmentSchema).default([]),
  next_cursor: z.string().nullable(),
});
export const conversationChangeDetailSchema = z.object({
  revision: z.number().int().nonnegative(), file: conversationFileResourceSchema,
  patch: z.string(), before: z.string(), after: z.string(),
});
export type ConversationFileResource = z.infer<typeof conversationFileResourceSchema>;
export type ConversationResourceAttachment = z.infer<typeof conversationResourceAttachmentSchema>;
export type ConversationResources = z.infer<typeof conversationResourcesSchema>;
export type ConversationChangeDetail = z.infer<typeof conversationChangeDetailSchema>;
