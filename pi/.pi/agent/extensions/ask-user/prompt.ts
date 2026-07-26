/** Model-facing schema descriptions for ask_user questions and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  question: "The question to ask the user",
  questions: "Between 1 and 5 questions to present in one interaction",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Describes the ask_user tool's batched question flow. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one or more multiple-choice questions in a single interaction. Accepts 1-5 questions with 2-5 options each. A free-form answer is added to every question, and the user may dismiss the interaction without answering.";

/** Adds ask_user's batched multiple-choice capability to the available-tools prompt. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask 1-5 multiple-choice questions in one interaction (2-5 options each plus free-form answers)";

/** Guides the model to group related questions into one ask_user call. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking questions whose likely answers can be enumerated, use the ask_user tool instead of asking in plain text.",
  "Group related questions into one ask_user call when their answers do not determine which follow-up questions are needed.",
];

interface AnswerSummary {
  question: string;
  answer: string;
  wasCustom: boolean;
  index?: number;
}

/** Builds the behavioral tool-result message returned to the parent model. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "answered"; answers: AnswerSummary[] },
) {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the questions could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the questions without submitting all answers. Do not assume any answers; proceed accordingly or ask differently.";
    case "answered":
      return outcome.answers
        .map((answer, index) => {
          const value = answer.wasCustom
            ? `wrote their own answer: ${answer.answer}`
            : `selected option ${answer.index}: ${answer.answer}`;
          return `Question ${index + 1} (${answer.question}): user ${value}`;
        })
        .join("\n");
  }
}
