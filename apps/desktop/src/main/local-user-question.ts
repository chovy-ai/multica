import { z } from "zod";
import type { LocalUserQuestionInput, LocalUserQuestionResult } from "@multica/core/local-conversation/protocol";

const question = z.object({
  id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  header: z.string().trim().min(1).max(40).optional(),
  question: z.string().trim().min(1).max(4000),
  options: z.array(z.object({ label: z.string().trim().min(1).max(200), description: z.string().max(1000).optional() })).max(8).default([]),
  multiSelect: z.boolean().default(false),
  allowFreeText: z.boolean().default(true),
}).refine((value) => value.allowFreeText || value.options.length > 0, "Fixed-choice questions need options")
  .refine((value) => new Set(value.options.map((option) => option.label)).size === value.options.length, "Option labels must be unique");

export const userQuestionShape = {
  request_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  questions: z.array(question).min(1).max(4).refine((value) => new Set(value.map((item) => item.id)).size === value.length, "Question IDs must be unique"),
};
export const userQuestionSchema = z.object(userQuestionShape);
export type AskLocalUser = (input: LocalUserQuestionInput, signal: AbortSignal) => Promise<LocalUserQuestionResult>;

export function userQuestionAnswers(input: LocalUserQuestionInput, raw: unknown): LocalUserQuestionResult["answersByQuestionId"] {
  const values = z.record(z.string(), z.union([z.string().trim().min(1).max(20000), z.array(z.string().trim().min(1).max(20000)).min(1).max(9)])).parse(raw);
  if (Object.keys(values).length !== input.questions.length) throw new Error("Answer every question in this request");
  const answers = Object.create(null) as Record<string, string | string[]>;
  for (const item of input.questions) {
    if (!Object.hasOwn(values, item.id)) throw new Error("Answer every question in this request");
    const value = values[item.id]!;
    const selected = Array.isArray(value) ? value : [value];
    if (!item.multiSelect && selected.length !== 1) throw new Error("Choose one answer for this question");
    if (!item.allowFreeText && selected.some((answer) => !item.options.some((option) => option.label === answer))) throw new Error("Choose one of the offered answers");
    answers[item.id] = item.multiSelect ? [...new Set(selected)] : selected[0]!;
  }
  return answers;
}
