import type { AgentAskUserQuestionVM } from "./contracts/agentAskUserQuestionItemVM";

/**
 * Single source of truth for turning a raw AskUserQuestion tool input's
 * `questions` array into the view-model shape. Both the in-conversation tool
 * projection and the message-center derivation call this, so the two surfaces
 * can never drift on which fields they read or how they default them (the
 * exact class of bug that left the message-center card without its options).
 *
 * Input shape (codex / ACP): each entry may carry `id`, `header`, `question`,
 * `multiSelect`, `allowFreeText`, and `options: [{ id, label, description }]`.
 * Answers are layered on by the caller (the live projection knows them; a
 * pending prompt has none), so this returns the answer-less base.
 */
export function normalizeAskUserQuestions(
  rawQuestions: unknown,
  options: { missingText?: string } = {}
): AgentAskUserQuestionVM[] {
  const missingText = options.missingText ?? null;
  const seenQuestionIds = new Set<string>();
  return arrayValue(rawQuestions).flatMap((value, index) => {
    const question = objectValue(value);
    if (!question) {
      return [];
    }
    const questionId =
      stringValue(question.id) ?? askUserContractId("question", question);
    if (seenQuestionIds.has(questionId)) {
      return [];
    }
    seenQuestionIds.add(questionId);
    const seenOptionIds = new Set<string>();
    return [
      {
        id: questionId,
        header:
          stringValue(question.header) ??
          missingText ??
          `Question ${index + 1}`,
        question:
          stringValue(question.question) ??
          stringValue(question.header) ??
          missingText ??
          `Question ${index + 1}`,
        options: arrayValue(question.options).flatMap((optionValue) => {
          const option = objectValue(optionValue);
          const label = stringValue(option?.label);
          if (!label) {
            return [];
          }
          const description = stringValue(option?.description) ?? "";
          const optionId =
            stringValue(option?.id) ??
            askUserContractId("option", {
              description,
              label,
              questionId
            });
          if (seenOptionIds.has(optionId)) {
            return [];
          }
          seenOptionIds.add(optionId);
          return [
            {
              id: optionId,
              label,
              description
            }
          ];
        }),
        multiSelect: Boolean(question.multiSelect),
        ...(question.allowFreeText === false ||
        question.allow_free_text === false
          ? { allowFreeText: false }
          : {})
      }
    ];
  });
}

/**
 * Provider payloads may omit UI-facing question or option IDs. Create an
 * opaque, deterministic contract identity at the normalization boundary so
 * renderers and automation never fall back to array position or inspect
 * rendered copy.
 */
function askUserContractId(
  scope: "question" | "option",
  value: unknown
): string {
  let hash = 0x811c9dc5;
  for (const character of JSON.stringify(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `contract-${scope}-${(hash >>> 0).toString(36)}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
