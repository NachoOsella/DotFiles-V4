import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractPlanSteps, isSafePlanModeCommand } from "./plan-utils.js";
import { registerRequestUserInputTool } from "./request-user-input.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "request_user_input"];
const FALLBACK_EXECUTE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "request_user_input"];
const STATE_ENTRY = "codex-plan-mode";
const STATUS_ID = "codex-plan-mode";
const WIDGET_ID = "codex-plan-mode-steps";
const MAX_WIDGET_STEPS = 6;

interface PersistedState {
	enabled?: boolean;
	lastPlanSteps?: string[];
	previousTools?: string[];
	kickoffPending?: boolean;
	approvedPlanForExecution?: string[];
}

export default function codexPlanModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let lastPlanSteps: string[] = [];
	let toolsBeforePlan: string[] | null = null;
	let promptingPlanDecision = false;
	let implementationKickoffPending = false;
	let approvedPlanForExecution: string[] = [];

	registerRequestUserInputTool(pi);

	pi.registerFlag("plan", {
		description: "Start in Codex-style plan mode",
		type: "boolean",
		default: false,
	});

	function uniqueTools(tools: string[]): string[] {
		return [...new Set(tools)];
	}

	function persistState(): void {
		pi.appendEntry(STATE_ENTRY, {
			enabled: planModeEnabled,
			lastPlanSteps,
			previousTools: toolsBeforePlan ?? undefined,
			kickoffPending: implementationKickoffPending,
			approvedPlanForExecution,
		} as PersistedState);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "⏸ PLAN"));
		} else {
			ctx.ui.setStatus(STATUS_ID, undefined);
		}

		if (planModeEnabled && lastPlanSteps.length > 0) {
			const lines = [ctx.ui.theme.fg("accent", "Plan draft")];
			for (let i = 0; i < Math.min(lastPlanSteps.length, MAX_WIDGET_STEPS); i += 1) {
				lines.push(`${ctx.ui.theme.fg("muted", `${i + 1}.`)} ${lastPlanSteps[i]}`);
			}
			if (lastPlanSteps.length > MAX_WIDGET_STEPS) {
				lines.push(ctx.ui.theme.fg("dim", `+${lastPlanSteps.length - MAX_WIDGET_STEPS} steps more`));
			}
			ctx.ui.setWidget(WIDGET_ID, lines);
		} else {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
	}

	function enablePlanMode(ctx: ExtensionContext, notify = true): void {
		if (planModeEnabled) return;
		planModeEnabled = true;
		if (!toolsBeforePlan || toolsBeforePlan.length === 0) {
			toolsBeforePlan = pi.getActiveTools();
		}
		pi.setActiveTools(uniqueTools(PLAN_MODE_TOOLS));
		if (notify) {
			ctx.ui.notify("Plan mode enabled (Codex-style).", "info");
		}
		updateUi(ctx);
		persistState();
	}

	function disablePlanMode(ctx: ExtensionContext, notify = true): void {
		if (!planModeEnabled) return;
		planModeEnabled = false;
		const restored = toolsBeforePlan && toolsBeforePlan.length > 0 ? toolsBeforePlan : FALLBACK_EXECUTE_TOOLS;
		pi.setActiveTools(uniqueTools([...restored, "request_user_input"]));
		toolsBeforePlan = null;
		if (notify) {
			ctx.ui.notify("Plan mode disabled. Back to execute mode.", "info");
		}
		updateUi(ctx);
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			disablePlanMode(ctx);
			implementationKickoffPending = false;
			approvedPlanForExecution = [];
			persistState();
		} else {
			enablePlanMode(ctx);
		}
	}

	pi.registerCommand("plan", {
		description: "Toggle Codex-style plan mode",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan mode status",
		handler: async (_args, ctx) => {
			const state = planModeEnabled ? "enabled" : "disabled";
			const planSummary =
				lastPlanSteps.length === 0
					? "No plan parsed yet."
					: lastPlanSteps.map((step, index) => `${index + 1}. ${step}`).join("\n");
			ctx.ui.notify(`Plan mode: ${state}\n\n${planSummary}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle Codex-style plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: string })?.command ?? "");
			if (!isSafePlanModeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode only allows read-only bash commands. Blocked:\n${command}`,
				};
			}
			return;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: `Tool ${event.toolName} is disabled in plan mode. Finish planning first.`,
			};
		}
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const currentPlan =
				lastPlanSteps.length > 0
					? `\nCurrent draft plan:\n${lastPlanSteps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n`
					: "";

			return {
				message: {
					customType: "codex-plan-mode-context",
					display: false,
					content: `[CODEX-STYLE PLAN MODE]\nYou are in planning mode (read-only).\n\nRules:\n- Allowed tools: read, bash, grep, find, ls, request_user_input.\n- Forbidden tools: edit, write.\n- Use request_user_input for structured clarifications when requirements are ambiguous (1-3 focused questions, 2-4 options each).\n- You may ask multiple rounds of questions if needed.\n- When ready, output a final plan under a \"Plan:\" header with numbered steps.\n- KEEP STEPS HIGH-LEVEL (4-7 items max). Group related subtasks under a single broad step. Do NOT list granular implementation details.\n- Do not output sub-steps or nested lists inside the Plan header.${currentPlan}\nDo not implement yet; planning only.`,
				},
			};
		}

		if (!implementationKickoffPending || approvedPlanForExecution.length === 0) return;

		implementationKickoffPending = false;
		persistState();
		const skillHints = getSkillCommandHints(pi);

		return {
			message: {
				customType: "codex-plan-implementation-kickoff",
				display: false,
				content: buildImplementationKickoffMessage(approvedPlanForExecution, skillHints),
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI || promptingPlanDecision) return;

		const assistantText = extractLastAssistantText(event.messages as unknown[]);
		if (!assistantText) return;

		const extracted = extractPlanSteps(assistantText);
		const decisionLikeText = looksLikeImplementationDecisionPrompt(assistantText);
		const shouldPrompt = planModeEnabled
			? extracted.length > 0
			: decisionLikeText && (extracted.length > 0 || lastPlanSteps.length > 0);
		if (!shouldPrompt) return;

		const steps = extracted.length > 0 ? extracted : lastPlanSteps;
		if (steps.length === 0) return;

		lastPlanSteps = steps;
		if (planModeEnabled) {
			updateUi(ctx);
		}
		persistState();

		promptingPlanDecision = true;
		try {
			const choice = await ctx.ui.select("Implement this plan?", [
				"Yes, implement this plan",
				"No, stay in Plan mode",
				"Refine with additional feedback",
			]);

			if (!choice) return;

			if (choice === "Yes, implement this plan") {
				const approved = [...lastPlanSteps];
				if (planModeEnabled) {
					disablePlanMode(ctx, false);
				}
				approvedPlanForExecution = approved;
				implementationKickoffPending = true;
				persistState();
				pi.events.emit("codex-plan-mode:approved-plan", {
					steps: approved,
					replace: true,
					source: "codex-plan-mode",
				});
				ctx.ui.notify("Switching to execute mode. Plan will be split into todos before implementation.", "info");
				pi.sendUserMessage("Implement the approved plan.");
				return;
			}

			if (choice === "Refine with additional feedback") {
				const feedback = await ctx.ui.editor("How should the plan be refined?", "");
				if (feedback?.trim()) {
					pi.sendUserMessage(`Refine the plan using this feedback:\n${feedback.trim()}`);
				}
			}
		} finally {
			promptingPlanDecision = false;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type?: string;
			customType?: string;
			data?: PersistedState;
		}>;

		const latest = entries
			.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
			.pop();

		if (latest?.data) {
			planModeEnabled = latest.data.enabled === true;
			lastPlanSteps = Array.isArray(latest.data.lastPlanSteps) ? latest.data.lastPlanSteps : [];
			toolsBeforePlan = Array.isArray(latest.data.previousTools) ? latest.data.previousTools : toolsBeforePlan;
			implementationKickoffPending = latest.data.kickoffPending === true;
			approvedPlanForExecution = Array.isArray(latest.data.approvedPlanForExecution)
				? latest.data.approvedPlanForExecution
				: [];
		}

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		if (planModeEnabled) {
			if (!toolsBeforePlan || toolsBeforePlan.length === 0) {
				toolsBeforePlan = pi.getActiveTools();
			}
			pi.setActiveTools(uniqueTools(PLAN_MODE_TOOLS));
		}

		updateUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		persistState();
	});
}

function extractLastAssistantText(messages: unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role !== "assistant") continue;
		const text = blocksToText(message.content);
		if (text.trim().length > 0) return text;
	}
	return undefined;
}

function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function getSkillCommandHints(pi: ExtensionAPI): string[] {
	const maybePi = pi as unknown as {
		getCommands?: () => Array<{ name: string; source?: string }>;
	};
	if (typeof maybePi.getCommands !== "function") return [];

	try {
		return maybePi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => `/${command.name}`)
			.slice(0, 24);
	} catch {
		return [];
	}
}

function buildImplementationKickoffMessage(planSteps: string[], skillHints: string[]): string {
	const planList = planSteps.map((step, index) => `${index + 1}. ${step}`).join("\n");
	const skillLine =
		skillHints.length > 0
			? `Available skill commands: ${skillHints.join(", ")}.`
			: "Identify required skills and actively look for matching /skill:* commands before coding.";

	return `[IMPLEMENTATION KICKOFF]\nApproved plan:\n${planList}\n\nExecution protocol (must follow):\n1) The plan steps were already imported into todo by the extension. First call todo with action:list to verify current ids. Do NOT re-add the entire plan unless todos are missing.\n2) If you need more granular tracking during implementation, create new specific todos as needed instead of breaking the high-level plan upfront.\n3) Before coding, determine which skills are needed for the plan and apply them explicitly. ${skillLine}\n4) Then implement step-by-step, updating todo progress by id as each step is completed.\n5) If implementation reveals missing info, ask follow-up clarifications and refine affected todo items.`;
}

function looksLikeImplementationDecisionPrompt(text: string): boolean {
	const normalized = text.toLowerCase();
	return [
		"implement this plan",
		"stay in plan mode",
		"refine the plan",
		"proceda con la implementación",
		"seguir refinando",
		"ajustar algo del plan",
	]
		.some((token) => normalized.includes(token));
}
