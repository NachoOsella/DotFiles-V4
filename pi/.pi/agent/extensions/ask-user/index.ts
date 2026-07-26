import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_QUESTIONS = 5;

const OptionSchema = Type.Object({
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;
type Question = AskUserInput["questions"][number];

interface Answer {
  question: string;
  answer: string;
  wasCustom: boolean;
  index?: number;
}

interface AskUserDetails {
  questions: Array<{ question: string; options: string[] }>;
  answers: Answer[];
  cancelled: boolean;
}

type SelectionResult = Answer[] | null;

interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as AskUserInput;
      const input = args as {
        questions?: unknown;
        question?: unknown;
        options?: unknown;
      };
      if (input.questions === undefined && typeof input.question === "string") {
        return {
          questions: [{ question: input.question, options: input.options }],
        } as AskUserInput;
      }
      return args as AskUserInput;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questionDetails = params.questions.map((question) => ({
        question: question.question,
        options: question.options.map((option) => option.label),
      }));
      const reply = (text: string, answers: Answer[] = []) => ({
        content: [{ type: "text" as const, text }],
        details: {
          questions: questionDetails,
          answers,
          cancelled: answers.length !== params.questions.length,
        } satisfies AskUserDetails,
      });

      for (const [index, question] of params.questions.entries()) {
        if (
          question.options.length < MIN_OPTIONS ||
          question.options.length > MAX_OPTIONS
        ) {
          throw new Error(
            `Question ${index + 1} requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${question.options.length}).`,
          );
        }
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }
      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const showQuestions = (uiSignal: AbortSignal) =>
        ctx.ui.custom<SelectionResult>((tui, theme, _keybindings, done) => {
          let questionIndex = 0;
          let optionIndex = 0;
          let editMode = false;
          let cachedLines: string[] | undefined;
          let settled = false;
          const answers = new Map<number, Answer>();

          function finish(result: SelectionResult) {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", cancel);
            done(result);
          }

          function cancel() {
            finish(null);
          }

          uiSignal.addEventListener("abort", cancel, { once: true });
          if (uiSignal.aborted) queueMicrotask(cancel);

          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function currentQuestion(): Question {
            return params.questions[questionIndex];
          }

          function currentOptions(): DisplayOption[] {
            return [
              ...currentQuestion().options,
              { label: "Write my own answer...", isOther: true },
            ];
          }

          function advance() {
            editMode = false;
            editor.setText("");
            if (questionIndex === params.questions.length - 1) {
              finish(
                params.questions.map((_question, index) => answers.get(index)!),
              );
              return;
            }
            questionIndex++;
            optionIndex = 0;
            refresh();
          }

          function saveAnswer(answer: string, wasCustom: boolean, index?: number) {
            answers.set(questionIndex, {
              question: currentQuestion().question,
              answer,
              wasCustom,
              index,
            });
            advance();
          }

          editor.onSubmit = (value) => {
            const trimmed = value.trim();
            if (trimmed) {
              saveAnswer(trimmed, true);
            } else {
              editMode = false;
              editor.setText("");
              refresh();
            }
          };

          function selectOption(index: number) {
            const selected = currentOptions()[index];
            if (selected.isOther) {
              optionIndex = index;
              editMode = true;
              refresh();
              return;
            }
            saveAnswer(selected.label, false, index + 1);
          }

          function moveQuestion(offset: number) {
            const next = questionIndex + offset;
            if (next < 0 || next >= params.questions.length) return;
            questionIndex = next;
            optionIndex = 0;
            editMode = false;
            editor.setText("");
            refresh();
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            const options = currentOptions();
            if (matchesKey(data, Key.left)) {
              moveQuestion(-1);
              return;
            }
            if (matchesKey(data, Key.right)) {
              moveQuestion(1);
              return;
            }
            if (matchesKey(data, Key.up)) {
              optionIndex = (optionIndex - 1 + options.length) % options.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = (optionIndex + 1) % options.length;
              refresh();
              return;
            }
            if (
              data.length === 1 &&
              data >= "1" &&
              data <= String(options.length)
            ) {
              selectOption(Number(data) - 1);
              return;
            }
            if (matchesKey(data, Key.enter)) {
              selectOption(optionIndex);
              return;
            }
            if (matchesKey(data, Key.escape)) finish(null);
          }

          function render(width: number): string[] {
            if (cachedLines) return cachedLines;

            const question = currentQuestion();
            const options = currentOptions();
            const lines: string[] = [];
            const add = (text: string) =>
              lines.push(truncateToWidth(text, Math.max(1, width)));
            const title = ` Question ${questionIndex + 1}/${params.questions.length} `;
            add(
              theme.fg(
                "accent",
                `-${title}${"-".repeat(Math.max(0, width - title.length - 1))}`,
              ),
            );

            const progress = params.questions
              .map((_item, index) => {
                const marker = answers.has(index) ? "x" : " ";
                const label = `[${marker}] ${index + 1}`;
                return index === questionIndex
                  ? theme.fg("accent", theme.bold(label))
                  : theme.fg(answers.has(index) ? "success" : "muted", label);
              })
              .join("  ");
            add(` ${progress}`);
            lines.push("");

            for (const line of wrapText(question.question, Math.max(10, width - 2))) {
              add(` ${theme.fg("text", theme.bold(line))}`);
            }
            lines.push("");

            for (let index = 0; index < options.length; index++) {
              const option = options[index];
              const selected = index === optionIndex;
              const prefix = selected ? theme.fg("accent", " > ") : "   ";
              const marker = option.isOther ? ">" : `${index + 1}.`;
              const label = `${marker} ${option.label}`;
              add(
                prefix +
                  theme.fg(
                    selected ? "accent" : option.isOther ? "muted" : "text",
                    label,
                  ),
              );
              if (option.description) {
                add(`      ${theme.fg("muted", option.description)}`);
              }
            }

            if (editMode) {
              lines.push("");
              add(theme.fg("muted", " Your answer:"));
              for (const line of editor.render(Math.max(1, width - 2))) {
                add(` ${line}`);
              }
            }

            lines.push("");
            add(
              theme.fg(
                "dim",
                editMode
                  ? " Enter submit - Esc back to options"
                  : ` Up/Down or 1-${options.length} select - Left/Right questions - Esc dismiss`,
              ),
            );
            add(theme.fg("accent", "-".repeat(Math.max(1, width))));
            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
            dispose: () => uiSignal.removeEventListener("abort", cancel),
          };
        });

      const uiExit = await Effect.runPromiseExit(
        Effect.tryPromise(showQuestions),
        signal ? { signal } : undefined,
      );

      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }));
        }
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const answers = uiExit.value;
      if (!answers) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }
      return reply(buildAskUserResultMessage({ kind: "answered", answers }), answers);
    },

    renderCall(args, theme, _context) {
      const questions = Array.isArray(args.questions)
        ? (args.questions as Question[])
        : [];
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        `${questions.length} question${questions.length === 1 ? "" : "s"}`,
      );
      for (const [index, question] of questions.entries()) {
        text += `\n${theme.fg("dim", `  ${index + 1}. ${question.question}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Dismissed"), 0, 0);
      }
      const lines = details.answers.map((answer, index) => {
        const value = answer.wasCustom
          ? `(wrote) ${answer.answer}`
          : `${answer.index}. ${answer.answer}`;
        return `${theme.fg("success", "OK ")}${theme.fg("accent", `${index + 1}.`)} ${value}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
