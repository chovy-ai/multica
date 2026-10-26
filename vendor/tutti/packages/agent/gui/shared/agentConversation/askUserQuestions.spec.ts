import { describe, expect, it } from "vitest";
import { normalizeAskUserQuestions } from "./askUserQuestions";

describe("normalizeAskUserQuestions", () => {
  it("maps header / question / options and defaults multiSelect to false", () => {
    expect(
      normalizeAskUserQuestions([
        {
          id: "plan-kind",
          header: "Plan topic",
          question: "Which kind of plan?",
          options: [
            {
              id: "health-check",
              label: "Health check",
              description: "Audit the repo"
            },
            { id: "feature-plan", label: "Feature plan" }
          ]
        }
      ])
    ).toEqual([
      {
        id: "plan-kind",
        header: "Plan topic",
        question: "Which kind of plan?",
        options: [
          {
            id: "health-check",
            label: "Health check",
            description: "Audit the repo"
          },
          { id: "feature-plan", label: "Feature plan", description: "" }
        ],
        multiSelect: false
      }
    ]);
  });

  it("generates deterministic contract IDs for missing provider identities", () => {
    const rawQuestions = [
      {
        header: "Choose",
        question: "Which path?",
        options: [{ label: "Keep", description: "Reuse the renderer" }]
      }
    ];
    const first = normalizeAskUserQuestions(rawQuestions);
    const second = normalizeAskUserQuestions(rawQuestions);

    expect(second).toEqual(first);
    expect(first).toEqual([
      {
        id: expect.stringMatching(/^contract-question-/u),
        header: "Choose",
        question: "Which path?",
        options: [
          {
            id: expect.stringMatching(/^contract-option-/u),
            label: "Keep",
            description: "Reuse the renderer"
          }
        ],
        multiSelect: false
      }
    ]);
  });

  it("drops malformed entries and duplicate contract identities", () => {
    expect(
      normalizeAskUserQuestions([
        null,
        { id: "question-1", options: [{ description: "no label" }] },
        {
          id: "question-1",
          options: [{ id: "keep", label: "Keep" }]
        },
        {
          id: "question-1",
          options: [{ id: "other", label: "Duplicate question" }]
        }
      ])
    ).toEqual([
      {
        id: "question-1",
        header: "Question 2",
        question: "Question 2",
        options: [],
        multiSelect: false
      }
    ]);
  });

  it("falls back to the header for the question text and carries multiSelect", () => {
    expect(
      normalizeAskUserQuestions([
        { id: "q", header: "Pick some", multiSelect: true }
      ])
    ).toEqual([
      {
        id: "q",
        header: "Pick some",
        question: "Pick some",
        options: [],
        multiSelect: true
      }
    ]);
  });

  it("preserves an option-only answer surface", () => {
    expect(
      normalizeAskUserQuestions([
        {
          id: "question-1",
          question: "Pick one",
          options: [{ id: "a", label: "A" }],
          allowFreeText: false
        }
      ])
    ).toEqual([
      {
        id: "question-1",
        header: "Question 1",
        question: "Pick one",
        options: [{ id: "a", label: "A", description: "" }],
        multiSelect: false,
        allowFreeText: false
      }
    ]);
  });

  it("ignores non-array input and non-object entries", () => {
    expect(normalizeAskUserQuestions(null)).toEqual([]);
    expect(normalizeAskUserQuestions("nope")).toEqual([]);
    expect(normalizeAskUserQuestions([null, 42, "x"])).toEqual([]);
  });
});
