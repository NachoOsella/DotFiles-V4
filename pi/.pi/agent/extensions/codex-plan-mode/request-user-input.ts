import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface UiOption {
	label: string;
	description?: string;
	isCustom?: boolean;
}

interface UiQuestion {
	id: string;
	header: string;
	question: string;
	options: UiOption[];
}

interface RequestUserInputResponse {
	answers: Record<string, { answers: string[] }>;
}

interface RequestUserInputDetails {
	cancelled: boolean;
	questions: UiQuestion[];
	response: RequestUserInputResponse;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Short description for this option" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable id in snake_case" }),
	header: Type.Optional(Type.String({ description: "Short tab label (max 12 chars recommended)" })),
	question: Type.String({ description: "Question prompt" }),
	options: Type.Array(OptionSchema, { minItems: 1, description: "2-4 options is ideal" }),
	isOther: Type.Optional(Type.Boolean({ description: "Add a write-in option (default: true)" })),
});

const RequestUserInputParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 6 }),
});

const CUSTOM_OPTION_LABEL = "None of the above";
const CUSTOM_OPTION_DESCRIPTION = "Optionally write your own answer/details";

export function registerRequestUserInputTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "request_user_input",
		label: "Request User Input",
		description:
			"Ask the user structured clarifying questions with tab navigation, option selection, and per-option extra notes.",
		parameters: RequestUserInputParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: request_user_input requires interactive UI mode." }],
					details: {
						cancelled: true,
						questions: [],
						response: { answers: {} },
					} as RequestUserInputDetails,
				};
			}

			const questions: UiQuestion[] = params.questions.map((question, index) => {
				const baseOptions = question.options.map((option) => ({
					label: option.label.trim(),
					description: option.description?.trim() || undefined,
				}));
				const options = question.isOther === false
					? baseOptions
					: [
							...baseOptions,
							{
								label: CUSTOM_OPTION_LABEL,
								description: CUSTOM_OPTION_DESCRIPTION,
								isCustom: true,
							},
						];

				return {
					id: question.id,
					header: (question.header?.trim() || `Q${index + 1}`).slice(0, 16),
					question: question.question.trim(),
					options,
				};
			});

			const result = await ctx.ui.custom<RequestUserInputDetails>((tui, theme, _kb, done) => {
				const totalTabs = questions.length + 1; // questions + submit tab
				const cursorByQuestion = questions.map(() => 0);
				const committedByQuestion: Array<number | null> = questions.map(() => null);
				const noteByQuestion = questions.map(() => "");

				let currentTab = 0;
				let inputMode = false;
				let inputQuestionIndex: number | null = null;
				let confirmUnanswered = false;
				let confirmChoice = 0; // 0 = proceed, 1 = go back
				let cachedLines: string[] | undefined;

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				function clamp(value: number, min: number, max: number): number {
					return Math.max(min, Math.min(max, value));
				}

				function isAnswered(questionIndex: number): boolean {
					return committedByQuestion[questionIndex] != null;
				}

				function unansweredIndices(): number[] {
					const out: number[] = [];
					for (let i = 0; i < questions.length; i += 1) {
						if (!isAnswered(i)) out.push(i);
					}
					return out;
				}

				function allAnswered(): boolean {
					return unansweredIndices().length === 0;
				}

				function firstUnanswered(): number {
					return unansweredIndices()[0] ?? 0;
				}

				function optionCount(questionIndex: number): number {
					return questions[questionIndex]?.options.length ?? 0;
				}

				function currentOptionCount(): number {
					return optionCount(currentTab);
				}

				function typedCharacter(data: string): string | null {
					if (!data || data.startsWith("\u001b")) return null;
					const chars = Array.from(data);
					if (chars.length !== 1) return null;
					const char = chars[0];
					const code = char.codePointAt(0) ?? 0;
					if (code < 32 || code === 127) return null;
					return char;
				}

				function moveToNextQuestionOrSubmitTab(): void {
					if (currentTab < questions.length - 1) {
						currentTab += 1;
					} else {
						currentTab = questions.length;
					}
				}

				function openNoteEditor(questionIndex: number, seed?: string): void {
					if (questionIndex < 0 || questionIndex >= questions.length) return;
					inputMode = true;
					inputQuestionIndex = questionIndex;
					const base = noteByQuestion[questionIndex] ?? "";
					editor.setText(seed ? `${base}${seed}` : base);
				}

				function commitSelection(questionIndex: number, selectedIndex: number, autoAdvance: boolean): void {
					if (selectedIndex < 0 || selectedIndex >= optionCount(questionIndex)) return;
					committedByQuestion[questionIndex] = selectedIndex;
					if (autoAdvance) moveToNextQuestionOrSubmitTab();
				}

				function buildResponse(): RequestUserInputResponse {
					const answers: Record<string, { answers: string[] }> = {};

					for (let i = 0; i < questions.length; i += 1) {
						const question = questions[i];
						const committedIndex = committedByQuestion[i];
						if (committedIndex == null) {
							answers[question.id] = { answers: [] };
							continue;
						}

						const selected = question.options[committedIndex];
						if (!selected) {
							answers[question.id] = { answers: [] };
							continue;
						}

						const lines = [selected.label];
						const note = noteByQuestion[i].trim();
						if (note.length > 0) {
							lines.push(`user_note: ${note}`);
						}
						answers[question.id] = { answers: lines };
					}

					return { answers };
				}

				function submit(cancelled: boolean): void {
					done({
						cancelled,
						questions,
						response: cancelled ? { answers: {} } : buildResponse(),
					});
				}

				editor.onSubmit = (value) => {
					const idx = inputQuestionIndex;
					if (idx == null) return;

					noteByQuestion[idx] = value.trim();
					commitSelection(idx, cursorByQuestion[idx], true);
					inputMode = false;
					inputQuestionIndex = null;
					editor.setText("");
					refresh();
				};

				function handleConfirmKeys(data: string): boolean {
					if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
						confirmChoice = clamp(confirmChoice - 1, 0, 1);
						refresh();
						return true;
					}
					if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
						confirmChoice = clamp(confirmChoice + 1, 0, 1);
						refresh();
						return true;
					}
					if (matchesKey(data, Key.enter)) {
						confirmUnanswered = false;
						if (confirmChoice === 0) {
							submit(false);
						} else {
							currentTab = firstUnanswered();
							refresh();
						}
						return true;
					}
					if (matchesKey(data, Key.escape)) {
						confirmUnanswered = false;
						currentTab = firstUnanswered();
						refresh();
						return true;
					}
					return false;
				}

				function handleInput(data: string): void {
					if (confirmUnanswered) {
						handleConfirmKeys(data);
						return;
					}

					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionIndex = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
						return;
					}

					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.ctrl("n"))) {
						currentTab = (currentTab + 1) % totalTabs;
						refresh();
						return;
					}
					if (
						matchesKey(data, Key.shift("tab")) ||
						matchesKey(data, Key.left) ||
						matchesKey(data, Key.ctrl("p"))
					) {
						currentTab = (currentTab - 1 + totalTabs) % totalTabs;
						refresh();
						return;
					}

					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter)) {
							if (allAnswered()) {
								submit(false);
							} else {
								confirmUnanswered = true;
								confirmChoice = 0;
								refresh();
							}
						}
						return;
					}

					const count = currentOptionCount();
					if (count === 0) return;

					if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
						cursorByQuestion[currentTab] = (cursorByQuestion[currentTab] - 1 + count) % count;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
						cursorByQuestion[currentTab] = (cursorByQuestion[currentTab] + 1) % count;
						refresh();
						return;
					}

					if (matchesKey(data, Key.space)) {
						commitSelection(currentTab, cursorByQuestion[currentTab], false);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						commitSelection(currentTab, cursorByQuestion[currentTab], true);
						refresh();
						return;
					}

					if (data.length === 1 && /[1-9]/.test(data)) {
						const idx = Number(data) - 1;
						if (idx >= 0 && idx < count) {
							cursorByQuestion[currentTab] = idx;
							commitSelection(currentTab, idx, true);
							refresh();
							return;
						}
					}

					const typed = typedCharacter(data);
					if (typed) {
						commitSelection(currentTab, cursorByQuestion[currentTab], false);
						openNoteEditor(currentTab, typed);
						refresh();
					}
				}

				function renderTabs(width: number): string {
					const parts: string[] = [];
					for (let i = 0; i < questions.length; i += 1) {
						const active = currentTab === i;
						const answered = isAnswered(i);
						const marker = answered ? "■" : "□";
						const raw = ` ${marker} ${questions[i].header} `;
						const styled = active
							? theme.bg("selectedBg", theme.fg("text", raw))
							: theme.fg(answered ? "success" : "muted", raw);
						parts.push(styled);
					}

					const submitRaw = " ✓ Submit ";
					const submitStyled =
						currentTab === questions.length
							? theme.bg("selectedBg", theme.fg("text", submitRaw))
							: theme.fg(allAnswered() ? "success" : "dim", submitRaw);
					parts.push(submitStyled);

					return truncateToWidth(parts.join(" "), width);
				}

				function renderSubmitSummary(width: number): string[] {
					const lines: string[] = [];
					for (let i = 0; i < questions.length; i += 1) {
						const question = questions[i];
						const committedIndex = committedByQuestion[i];
						if (committedIndex == null || !question.options[committedIndex]) {
							lines.push(truncateToWidth(theme.fg("warning", `• ${question.header}: unanswered`), width));
							continue;
						}

						const selected = question.options[committedIndex];
						const note = noteByQuestion[i].trim();
						const text = note.length > 0 ? `${selected.label} (${note})` : selected.label;
						lines.push(truncateToWidth(`${theme.fg("success", "✓")} ${question.header}: ${text}`, width));
					}
					return lines;
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (line = "") => lines.push(truncateToWidth(line, width));
					const divider = theme.fg("accent", "─".repeat(Math.max(1, width)));

					add(divider);
					add(theme.fg("accent", theme.bold(" Request user input")));
					add(renderTabs(width));
					lines.push("");

					if (confirmUnanswered) {
						const missing = unansweredIndices().length;
						add(theme.fg("warning", theme.bold(" Submit with unanswered questions?")));
						add(theme.fg("dim", ` ${missing} unanswered question${missing === 1 ? "" : "s"}.`));
						lines.push("");
						add(`${confirmChoice === 0 ? ">" : " "} ${theme.fg(confirmChoice === 0 ? "accent" : "text", "1. Proceed")}`);
						add(theme.fg("muted", "    Submit with partial answers"));
						add(`${confirmChoice === 1 ? ">" : " "} ${theme.fg(confirmChoice === 1 ? "accent" : "text", "2. Go back")}`);
						add(theme.fg("muted", "    Jump to the first unanswered question"));
						lines.push("");
						add(theme.fg("dim", " ↑↓ select • Enter confirm • Esc go back"));
						add(divider);
						cachedLines = lines;
						return lines;
					}

					if (currentTab === questions.length) {
						add(theme.fg("accent", theme.bold(" Review answers")));
						lines.push("");
						for (const line of renderSubmitSummary(width)) add(line);
						lines.push("");
						add(
							allAnswered()
								? theme.fg("success", " Press Enter to submit answers")
								: theme.fg("warning", " Some questions are still unanswered"),
						);
						lines.push("");
						add(theme.fg("dim", " Tab/Shift+Tab tabs • Enter submit • Esc cancel"));
						add(divider);
						cachedLines = lines;
						return lines;
					}

					const question = questions[currentTab];
					const cursor = cursorByQuestion[currentTab];
					add(theme.fg("text", ` ${theme.bold(question.header)} — ${question.question}`));
					lines.push("");

					for (let i = 0; i < question.options.length; i += 1) {
						const option = question.options[i];
						const selected = i === cursor;
						const prefix = selected ? theme.fg("accent", "> ") : "  ";
						const color = selected ? "accent" : "text";
						add(`${prefix}${theme.fg(color, `${i + 1}. ${option.label}`)}`);
						if (option.description) add(`    ${theme.fg("muted", option.description)}`);
					}

					if (inputMode && inputQuestionIndex === currentTab) {
						lines.push("");
						add(theme.fg("muted", " Add extra detail to this option:"));
						for (const editorLine of editor.render(Math.max(1, width - 1))) {
							add(` ${editorLine}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter save+next • Esc cancel"));
					} else {
						const committedIndex = committedByQuestion[currentTab];
						if (committedIndex != null && question.options[committedIndex]) {
							const selected = question.options[committedIndex];
							const note = noteByQuestion[currentTab].trim();
							const text = note.length > 0 ? `${selected.label} (${note})` : selected.label;
							lines.push("");
							add(`${theme.fg("success", "✓ Committed:")} ${truncateToWidth(text, Math.max(1, width - 13))}`);
						}
						lines.push("");
						add(
							theme.fg(
								"dim",
								" Tab/Shift+Tab tabs • ↑↓ select • Enter commit • 1-9 quick pick • type to add detail • Esc cancel",
							),
						);
					}

					add(divider);
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "request_user_input cancelled by user." }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: JSON.stringify(result.response, null, 2) }],
				details: result,
			};
		},

		renderCall(args, theme) {
			const questions = ((args as { questions?: unknown }).questions ?? []) as Array<{ header?: string; id?: string }>;
			const labels = questions.map((q, index) => q.header || q.id || `Q${index + 1}`);
			let text = theme.fg("toolTitle", theme.bold("request_user_input "));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (labels.length > 0) {
				text += theme.fg("dim", ` (${truncateToWidth(labels.join(", "), 36)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as RequestUserInputDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines: string[] = [];
			for (const question of details.questions) {
				const answer = details.response.answers[question.id]?.answers ?? [];
				if (answer.length === 0) {
					lines.push(`${theme.fg("warning", "•")} ${question.header}: unanswered`);
				} else {
					lines.push(`${theme.fg("success", "✓")} ${question.header}: ${answer.join(" | ")}`);
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
