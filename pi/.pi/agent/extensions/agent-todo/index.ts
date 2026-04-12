/**
 * Agent Todo Extension — Claude Code style todo loop
 *
 * - Adds `todo` tool for LLM-managed task tracking
 * - Enforces completing pending todos before stopping
 * - Adds `/todos` interactive view with keyboard controls
 * - Keeps status updated and flashes widget on todo updates
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "add" | "complete" | "done" | "list" | "show" | "remove" | "clear";
	todos: Todo[];
	nextId: number;
	addedIds?: number[];
	completedSnapshot?: Todo[];
	autoCleared?: boolean;
	error?: string;
}

interface TodoPlanImportDetails {
	todos: Todo[];
	nextId: number;
	source?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["add", "complete", "done", "list", "show", "remove", "clear"] as const, {
		description: "Todo action",
	}),
	text: Type.Optional(Type.String({ description: "Single todo text" })),
	texts: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Batch add todos",
			minItems: 1,
		}),
	),
	id: Type.Optional(Type.Number({ description: "Todo id" })),
	ids: Type.Optional(Type.Array(Type.Number(), { description: "Batch todo ids for complete/remove" })),
});

let todos: Todo[] = [];
let nextId = 1;
let lastCompletedId: number | null = null;
let widgetClearTimer: ReturnType<typeof setTimeout> | null = null;
let latestCtx: ExtensionContext | null = null;

function resetTodos(): void {
	todos = [];
	nextId = 1;
	lastCompletedId = null;
}

function cloneTodos(list: Todo[]): Todo[] {
	return list.map((t) => ({ ...t }));
}

function snapshotTodos(): Todo[] {
	return cloneTodos(todos);
}

function reconstructState(ctx: ExtensionContext): void {
	todos = [];
	nextId = 1;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (!details) continue;
			todos = cloneTodos(details.todos);
			nextId = details.nextId;
			continue;
		}

		if (entry.type === "custom" && entry.customType === "todo-plan-import") {
			const details = entry.data as TodoPlanImportDetails | undefined;
			if (!details) continue;
			todos = cloneTodos(details.todos ?? []);
			nextId = typeof details.nextId === "number" && details.nextId > 0 ? details.nextId : nextId;
		}
	}

	const lastDone = [...todos].reverse().find((t) => t.done);
	lastCompletedId = lastDone?.id ?? null;
}

function doneCount(): number {
	return todos.filter((t) => t.done).length;
}

function pendingTodos(): Todo[] {
	return todos.filter((t) => !t.done);
}

function allDone(): boolean {
	return todos.length > 0 && pendingTodos().length === 0;
}

function progressBar(done: number, total: number, width: number): string {
	if (total <= 0) return `[${"░".repeat(width)}]`;
	const filled = Math.round((done / total) * width);
	return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
}

function normalizeAddTexts(text?: string, texts?: string[]): string[] {
	const fromArray = (texts ?? []).map((t) => t.trim()).filter(Boolean);
	const fromText = (text ?? "")
		.split("\n")
		.map((t) => t.trim())
		.filter(Boolean);
	return [...fromArray, ...fromText];
}

function normalizeTodoKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`*_"]/g, "")
		.replace(/\s+/g, " ")
		.replace(/[\s:;,.!-]+$/g, "")
		.trim();
}

function importPlanTodosFromSteps(steps: string[], replace = true): number {
	const normalized = steps.map((step) => step.trim()).filter(Boolean);
	if (normalized.length === 0) return 0;

	if (replace) {
		resetTodos();
	}

	const existing = new Set(todos.map((t) => t.text.toLowerCase()));
	let added = 0;

	for (const text of normalized) {
		const key = text.toLowerCase();
		if (existing.has(key)) continue;
		todos.push({ id: nextId++, text, done: false });
		existing.add(key);
		added += 1;
	}

	return added;
}

function buildTodoLines(theme: any, maxItems = 7): string[] {
	const currentTodo = todos.find((t) => !t.done);
	const lines: string[] = [];
	lines.push(`${theme.fg("success", "●")} ${theme.bold("Todos")}`);

	for (let i = 0; i < Math.min(todos.length, maxItems); i++) {
		const t = todos[i];
		const prefix = i === 0 ? "└" : " ";
		const icon = t.done ? "✓" : "☐";
		const isCurrent = currentTodo?.id === t.id;
		const isRecentDone = t.done && lastCompletedId === t.id;
		const iconStyled = t.done
			? theme.fg(isRecentDone ? "success" : "muted", icon)
			: theme.fg(isCurrent ? "accent" : "text", icon);
		const textStyled = isCurrent
			? theme.fg("accent", theme.bold(t.text))
			: t.done
				? theme.fg(isRecentDone ? "success" : "muted", t.text)
				: theme.fg("text", t.text);
		lines.push(`${prefix} ${iconStyled} ${textStyled}`);
	}

	if (todos.length > maxItems) lines.push(theme.fg("dim", `  +${todos.length - maxItems} more`));
	return lines;
}

function flashTodoWidget(ctx: ExtensionContext, holdMs = 4500): void {
	if (todos.length === 0 || !ctx.hasUI) {
		ctx.ui.setWidget("agent-todo", undefined);
		return;
	}
	ctx.ui.setWidget("agent-todo", buildTodoLines(ctx.ui.theme));
	if (widgetClearTimer) clearTimeout(widgetClearTimer);
	widgetClearTimer = setTimeout(() => {
		ctx.ui.setWidget("agent-todo", undefined);
		widgetClearTimer = null;
	}, holdMs);
}

function updateIndicators(ctx: ExtensionContext): void {
	if (todos.length === 0) {
		ctx.ui.setStatus("agent-todo", undefined);
		ctx.ui.setWidget("agent-todo", undefined);
		return;
	}

	const done = doneCount();
	const total = todos.length;
	const pending = total - done;
	if (allDone()) {
		ctx.ui.setStatus("agent-todo", ctx.ui.theme.fg("success", `✓ todos complete (${done}/${total})`));
	} else {
		ctx.ui.setStatus("agent-todo", ctx.ui.theme.fg("warning", `• todos (${pending} pending)`));
	}
}

const TODO_SYSTEM_PROMPT =
	"Use todo for multi-step work: add steps once with texts:[...], complete by id, and do not finish with pending todos.";

export default function agentTodo(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		reconstructState(ctx);
		if (widgetClearTimer) {
			clearTimeout(widgetClearTimer);
			widgetClearTimer = null;
		}
		ctx.ui.setWidget("agent-todo", undefined);
		updateIndicators(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		latestCtx = ctx;
		reconstructState(ctx);
		if (widgetClearTimer) {
			clearTimeout(widgetClearTimer);
			widgetClearTimer = null;
		}
		ctx.ui.setWidget("agent-todo", undefined);
		updateIndicators(ctx);
	});

	pi.on("session_shutdown", async () => {
		latestCtx = null;
		if (widgetClearTimer) {
			clearTimeout(widgetClearTimer);
			widgetClearTimer = null;
		}
	});

	pi.events.on("codex-plan-mode:approved-plan", (payload) => {
		const data = payload as { steps?: unknown; replace?: boolean; source?: string };
		const steps = Array.isArray(data?.steps)
			? data.steps.map((step) => (typeof step === "string" ? step : "")).filter(Boolean)
			: [];
		if (steps.length === 0) return;

		const added = importPlanTodosFromSteps(steps, data.replace !== false);
		if (added === 0) return;

		const ctx = latestCtx;
		if (ctx) {
			updateIndicators(ctx);
			flashTodoWidget(ctx, 7000);
			ctx.ui.notify(`Imported ${added} plan steps into todos`, "info");
		}

		pi.appendEntry("todo-plan-import", {
			source: data.source ?? "codex-plan-mode",
			todos: snapshotTodos(),
			nextId,
		} as TodoPlanImportDetails);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Task list tool: add/complete/list/remove/clear todos.",
		promptSnippet: "For multi-step work, use todo and keep it updated.",
		promptGuidelines: [
			"Create initial steps in one add call with texts:[...]",
			"Complete steps by id or ids:[...] and don't finish with pending todos",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action === "done" ? "complete" : params.action === "show" ? "list" : params.action;
			switch (action) {
				case "add": {
					const entries = normalizeAddTexts(params.text, params.texts);
					if (entries.length === 0) {
						return {
							content: [{ type: "text", text: "Error: 'texts' (or 'text') is required for add" }],
							details: {
								action: "add",
								todos: snapshotTodos(),
								nextId,
								error: "texts or text required",
							} as TodoDetails,
						};
					}

					const existingKeys = new Set(todos.map((todo) => normalizeTodoKey(todo.text)));
					const added: Todo[] = [];
					let skipped = 0;
					for (const text of entries) {
						const key = normalizeTodoKey(text);
						if (existingKeys.has(key)) {
							skipped += 1;
							continue;
						}
						existingKeys.add(key);
						const t: Todo = { id: nextId++, text, done: false };
						todos.push(t);
						added.push(t);
					}
					updateIndicators(ctx);
					if (added.length > 0) {
						flashTodoWidget(ctx);
					}

					const messageText =
						added.length === 0
							? skipped > 0
								? `Skipped ${skipped} duplicate todos`
								: "No todos added"
							: added.length === 1
								? `Added #${added[0].id}: ${added[0].text}${skipped > 0 ? ` (skipped ${skipped} duplicate${skipped === 1 ? "" : "s"})` : ""}`
								: `Added ${added.length} todos${skipped > 0 ? ` (skipped ${skipped} duplicate${skipped === 1 ? "" : "s"})` : ""}`;

					return {
						content: [{ type: "text", text: messageText }],
						details: {
							action: "add",
							todos: snapshotTodos(),
							nextId,
							addedIds: added.map((t) => t.id),
						} as TodoDetails,
					};
				}

				case "complete": {
					const targetIds = params.ids ?? (params.id !== undefined ? [params.id] : []);
					if (targetIds.length === 0) {
						return {
							content: [{ type: "text", text: "Error: 'id' or 'ids' is required for complete" }],
							details: { action: "complete", todos: snapshotTodos(), nextId, error: "id or ids required" } as TodoDetails,
						};
					}
					const completedIds: number[] = [];
					const notFoundIds: number[] = [];
					for (const targetId of targetIds) {
						const todo = todos.find((t) => t.id === targetId);
						if (todo) {
							if (!todo.done) {
								todo.done = true;
								completedIds.push(todo.id);
							}
						} else {
							notFoundIds.push(targetId);
						}
					}
					if (completedIds.length > 0) {
						lastCompletedId = completedIds[completedIds.length - 1];
					}

					const completedSnapshot = snapshotTodos();
					const autoCleared = completedSnapshot.length > 0 && completedSnapshot.every((t) => t.done);
					if (autoCleared) {
						resetTodos();
						updateIndicators(ctx);
					} else {
						updateIndicators(ctx);
						if (completedIds.length > 0) flashTodoWidget(ctx);
					}

					let msg = "";
					if (completedIds.length === 1) msg = `Done #${completedIds[0]}`;
					else if (completedIds.length > 1) msg = `Done ${completedIds.length} todos: #${completedIds.join(", #")}`;
					if (notFoundIds.length > 0) msg += (msg ? " | " : "") + `Not found: #${notFoundIds.join(", #")}`;
					if (!msg) msg = "No todos matched";

					return {
						content: [{ type: "text", text: msg }],
						details: {
							action: "complete",
							todos: autoCleared ? [] : snapshotTodos(),
							nextId,
							completedSnapshot: autoCleared ? completedSnapshot : undefined,
							autoCleared,
						} as TodoDetails,
					};
				}

				case "remove": {
					const targetIds = params.ids ?? (params.id !== undefined ? [params.id] : []);
					if (targetIds.length === 0) {
						return {
							content: [{ type: "text", text: "Error: 'id' or 'ids' is required for remove" }],
							details: { action: "remove", todos: snapshotTodos(), nextId, error: "id or ids required" } as TodoDetails,
						};
					}
					const removedIds: number[] = [];
					const notFoundIds: number[] = [];
					for (const targetId of targetIds) {
						const idx = todos.findIndex((t) => t.id === targetId);
						if (idx !== -1) {
							const removed = todos.splice(idx, 1)[0];
							removedIds.push(removed.id);
							if (removed.id === lastCompletedId) lastCompletedId = null;
						} else {
							notFoundIds.push(targetId);
						}
					}
					if (removedIds.length > 0) {
						updateIndicators(ctx);
						flashTodoWidget(ctx);
					}

					let msg = "";
					if (removedIds.length === 1) msg = `Removed #${removedIds[0]}`;
					else if (removedIds.length > 1) msg = `Removed ${removedIds.length} todos: #${removedIds.join(", #")}`;
					if (notFoundIds.length > 0) msg += (msg ? " | " : "") + `Not found: #${notFoundIds.join(", #")}`;
					if (!msg) msg = "No todos matched";

					return {
						content: [{ type: "text", text: msg }],
						details: { action: "remove", todos: snapshotTodos(), nextId } as TodoDetails,
					};
				}

				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `${t.done ? "✓" : "☐"} #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: snapshotTodos(), nextId } as TodoDetails,
					};

				case "clear":
					resetTodos();
					updateIndicators(ctx);
					flashTodoWidget(ctx);
					return {
						content: [{ type: "text", text: "Cleared all todos" }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }],
						details: { action: "list", todos: snapshotTodos(), nextId, error: "unknown action" } as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			const action = args.action === "done" ? "complete" : args.action === "show" ? "list" : args.action;
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
			if (Array.isArray(args.ids)) {
				text += " " + theme.fg("accent", `#${args.ids.join(", #")}`);
			} else if (args.id !== undefined) {
				text += " " + theme.fg("accent", `#${args.id}`);
			}
			const batch = Array.isArray(args.texts) ? args.texts.map((t) => `${t}`.trim()).filter(Boolean) : [];
			if (batch.length > 0) {
				const preview = batch.slice(0, 2).map((t) => `\"${t}\"`).join(", ");
				text += " " + theme.fg("dim", preview);
				if (batch.length > 2) text += " " + theme.fg("muted", `+${batch.length - 2}`);
			} else if (args.text) {
				text += " " + theme.fg("dim", `\"${args.text}\"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			switch (details.action) {
				case "add": {
					const addedMap = new Map(details.todos.map((t) => [t.id, t]));
					const added = (details.addedIds ?? [])
						.map((id) => addedMap.get(id))
						.filter((t): t is Todo => Boolean(t));
					if (added.length <= 1) {
						const single = added[0] ?? details.todos[details.todos.length - 1];
						return new Text(`${theme.fg("text", "☐")} ${theme.fg("toolOutput", single.text)}`, 0, 0);
					}
					const lines = [theme.fg("muted", `+${added.length} todos`)];
					for (const t of added.slice(0, 8)) lines.push(`${theme.fg("text", "☐")} ${theme.fg("toolOutput", t.text)}`);
					if (added.length > 8) lines.push(theme.fg("dim", `... +${added.length - 8} more`));
					return new Text(lines.join("\n"), 0, 0);
				}

				case "complete": {
					const viewTodos = details.completedSnapshot ?? details.todos;
					if (viewTodos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					const done = viewTodos.filter((t) => t.done).length;
					const total = viewTodos.length;
					const lines = viewTodos.map((t) => {
						const icon = t.done ? theme.fg("success", "✓") : theme.fg("text", "☐");
						const txt = t.done ? theme.fg("muted", t.text) : theme.fg("text", t.text);
						return `${icon} ${txt}`;
					});
					lines.unshift(theme.fg("muted", `${done}/${total}`));
					if (details.autoCleared) lines.push(theme.fg("dim", "all todos complete · list cleared"));
					return new Text(lines.join("\n"), 0, 0);
				}

				case "remove":
					return new Text(theme.fg("warning", "• Removed todo"), 0, 0);

				case "list": {
					if (details.todos.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					const pending = details.todos.filter((t) => !t.done);
					const done = details.todos.filter((t) => t.done);
					const lines: string[] = [];
					if (pending.length > 0) {
						lines.push(theme.fg("muted", "pending"));
						for (const t of pending.slice(0, 6)) {
							lines.push(`${theme.fg("text", "☐")} ${theme.fg("text", t.text)}`);
						}
					}
					if (done.length > 0) {
						if (lines.length > 0) lines.push("");
						lines.push(theme.fg("muted", "done"));
						for (const t of done.slice(0, 4)) {
							lines.push(`${theme.fg("success", "✓")} ${theme.fg("muted", t.text)}`);
						}
					}
					if (details.todos.length > 10) lines.push(theme.fg("dim", `... +${details.todos.length - 10} more`));
					return new Text(lines.join("\n"), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "Cleared all todos"), 0, 0);

				default:
					return new Text("", 0, 0);
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Open interactive todo list",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				if (todos.length === 0) {
					ctx.ui.notify("No todos", "info");
				} else {
					ctx.ui.notify(todos.map((t) => `${t.done ? "✓" : "☐"} #${t.id}: ${t.text}`).join("\n"), "info");
				}
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selectedId: number | null = pendingTodos()[0]?.id ?? todos[0]?.id ?? null;
				let cachedLines: string[] | undefined;

				const orderedTodos = () => [...todos];

				const refresh = () => {
					cachedLines = undefined;
					updateIndicators(ctx);
					tui.requestRender();
				};

				const ensureSelection = () => {
					if (todos.length === 0) {
						selectedId = null;
						return;
					}
					if (selectedId === null || !todos.some((t) => t.id === selectedId)) {
						selectedId = orderedTodos()[0]?.id ?? null;
					}
				};

				const move = (delta: number) => {
					const list = orderedTodos();
					if (list.length === 0) return;
					ensureSelection();
					const idx = Math.max(0, list.findIndex((t) => t.id === selectedId));
					const next = Math.max(0, Math.min(list.length - 1, idx + delta));
					selectedId = list[next].id;
					refresh();
				};

				const toggleSelected = () => {
					if (selectedId === null) return;
					const t = todos.find((todo) => todo.id === selectedId);
					if (!t) return;
					t.done = !t.done;
					if (t.done) lastCompletedId = t.id;
					else if (lastCompletedId === t.id) lastCompletedId = null;
					if (todos.length > 0 && todos.every((todo) => todo.done)) {
						resetTodos();
						selectedId = null;
					}
					refresh();
				};

				const removeSelected = () => {
					if (selectedId === null) return;
					const idx = todos.findIndex((t) => t.id === selectedId);
					if (idx === -1) return;
					const removed = todos.splice(idx, 1)[0];
					if (removed.id === lastCompletedId) lastCompletedId = null;
					selectedId = orderedTodos()[0]?.id ?? null;
					refresh();
				};

				const clearCompleted = () => {
					const before = todos.length;
					todos = todos.filter((t) => !t.done);
					if (todos.length !== before) {
						lastCompletedId = null;
						selectedId = orderedTodos()[0]?.id ?? null;
						refresh();
					}
				};

				const render = (width: number): string[] => {
					if (cachedLines) return cachedLines;
					ensureSelection();

					const lines: string[] = [];
					const add = (line: string) => lines.push(truncateToWidth(line, width));
					const ordered = orderedTodos();

					add(`${theme.fg("success", "●")} ${theme.bold("Todos")}`);

					if (ordered.length === 0) {
						add(theme.fg("dim", "└ No todos yet"));
					} else {
						for (let i = 0; i < ordered.length; i++) {
							const t = ordered[i];
							const selected = t.id === selectedId;
							const prefix = i === 0 ? "└" : " ";
							const icon = t.done ? "✓" : "☐";
							const isRecentDone = t.done && lastCompletedId === t.id;
							const iconStyled = t.done
								? theme.fg(isRecentDone ? "success" : "text", icon)
								: theme.fg(selected ? "accent" : "text", icon);
							const textStyled = selected
								? theme.fg("accent", theme.bold(t.text))
								: t.done
									? theme.fg(isRecentDone ? "success" : "text", t.text)
									: theme.fg("text", t.text);
							add(`${prefix} ${iconStyled} ${textStyled}`);
						}
					}

					lines.push("");
					add(theme.fg("dim", "↑↓ / j k move  •  space|enter toggle  •  d remove  •  c clear done  •  esc close"));

					cachedLines = lines;
					return lines;
				};

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							done();
							return;
						}
						if (matchesKey(data, "up") || data === "k") {
							move(-1);
							return;
						}
						if (matchesKey(data, "down") || data === "j") {
							move(1);
							return;
						}
						if (matchesKey(data, "space") || matchesKey(data, "enter")) {
							toggleSelected();
							return;
						}
						if (matchesKey(data, "delete") || matchesKey(data, "backspace") || data === "d") {
							removeSelected();
							return;
						}
						if (data === "c") {
							clearCompleted();
						}
					},
				};
			});
		},
	});

	pi.on("before_agent_start", async (event) => {
		const existing = event.systemPrompt || "";
		const pending = pendingTodos();

		if (pending.length > 0) {
			const pendingList = pending.map((t) => `  - #${t.id}: ${t.text}`).join("\n");
			return {
				systemPrompt:
					existing +
					`\n\nTODO: ${pending.length} pending. Continue and complete them before finishing.\n${pendingList}`,
			};
		}

		return { systemPrompt: existing + TODO_SYSTEM_PROMPT };
	});

	pi.on("agent_end", async (event) => {
		const pending = pendingTodos();
		if (pending.length === 0) return;

		const lastMsg = [...event.messages].reverse().find((m) => m.role === "assistant");
		if (!lastMsg) return;

		const textContent = (lastMsg.content || [])
			.filter((c: { type: string }) => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join(" ")
			.toLowerCase();

		const wrapUpPhrases = [
			"let me know",
			"feel free",
			"hope this helps",
			"is there anything else",
			"to summarize",
			"in conclusion",
			"all set",
		];

		if (wrapUpPhrases.some((p) => textContent.includes(p))) {
			const pendingList = pending.map((t) => `  - #${t.id}: ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "todo-enforcement",
					content: `Pending todos (${pending.length}):\n${pendingList}`,
					display: false,
				},
				{ triggerTurn: true },
			);
		}
	});
}
