import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractLastAssistantText, looksLikeImplementationDecisionPrompt } from "./messages.js";
import { parsePlan, isSafePlanModeCommand } from "./plan-utils.js";
import { buildCurrentPlanContext, buildImplementationKickoffMessage, buildMarkdownFromSteps, buildPlanModePrompt, formatPlanForDisplay, getSkillCommandHints } from "./prompts.js";
import { registerRequestUserInputTool } from "./request-user-input.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "request_user_input", "web_search", "code_search", "fetch_content", "get_search_content"];
const FALLBACK_EXECUTE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "request_user_input"];
const STATE_ENTRY = "codex-plan-mode";
const STATUS_ID = "codex-plan-mode";

interface PersistedState {
	enabled?: boolean;
	lastPlanMarkdown?: string;
	lastPlanSteps?: string[];
	previousTools?: string[];
	kickoffPending?: boolean;
	approvedPlanMarkdown?: string;
	approvedPlanForExecution?: string[];
}

export default function codexPlanModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let lastPlanMarkdown = "";
	let lastPlanSteps: string[] = [];
	let toolsBeforePlan: string[] | null = null;
	let promptingPlanDecision = false;
	let implementationKickoffPending = false;
	let approvedPlanMarkdown = "";
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
			lastPlanMarkdown,
			lastPlanSteps,
			previousTools: toolsBeforePlan ?? undefined,
			kickoffPending: implementationKickoffPending,
			approvedPlanMarkdown,
			approvedPlanForExecution,
		} as PersistedState);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "PLAN"));
		} else {
			ctx.ui.setStatus(STATUS_ID, undefined);
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
			approvedPlanMarkdown = "";
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
			const planSummary = formatPlanForDisplay(lastPlanMarkdown, lastPlanSteps);
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
			const currentPlan = buildCurrentPlanContext(lastPlanMarkdown, lastPlanSteps);

			return {
				message: {
					customType: "codex-plan-mode-context",
					display: false,
					content: buildPlanModePrompt(currentPlan),
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
				content: buildImplementationKickoffMessage(approvedPlanForExecution, approvedPlanMarkdown, skillHints),
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI || promptingPlanDecision) return;

		const assistantText = extractLastAssistantText(event.messages as unknown[]);
		if (!assistantText) return;

		const parsedPlan = parsePlan(assistantText);
		const decisionLikeText = looksLikeImplementationDecisionPrompt(assistantText);
		const shouldPrompt = planModeEnabled
			? parsedPlan.steps.length > 0
			: decisionLikeText && (parsedPlan.steps.length > 0 || lastPlanSteps.length > 0);
		if (!shouldPrompt) return;

		const steps = parsedPlan.steps.length > 0 ? parsedPlan.steps : lastPlanSteps;
		if (steps.length === 0) return;

		lastPlanSteps = steps;
		if (parsedPlan.markdown) {
			lastPlanMarkdown = parsedPlan.markdown;
		} else if (!lastPlanMarkdown) {
			lastPlanMarkdown = buildMarkdownFromSteps(steps);
		}
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
				const approvedSteps = [...lastPlanSteps];
				const approvedMarkdown = lastPlanMarkdown || buildMarkdownFromSteps(approvedSteps);
				if (planModeEnabled) {
					disablePlanMode(ctx, false);
				}
				approvedPlanMarkdown = approvedMarkdown;
				approvedPlanForExecution = approvedSteps;
				implementationKickoffPending = true;
				persistState();
				pi.events.emit("codex-plan-mode:approved-plan", {
					markdown: approvedMarkdown,
					steps: approvedSteps,
					replace: true,
					source: "codex-plan-mode",
				});
				ctx.ui.notify("Switching to execute mode.", "info");
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
			lastPlanMarkdown = typeof latest.data.lastPlanMarkdown === "string" ? latest.data.lastPlanMarkdown : "";
			lastPlanSteps = Array.isArray(latest.data.lastPlanSteps) ? latest.data.lastPlanSteps : [];
			toolsBeforePlan = Array.isArray(latest.data.previousTools) ? latest.data.previousTools : toolsBeforePlan;
			implementationKickoffPending = latest.data.kickoffPending === true;
			approvedPlanMarkdown = typeof latest.data.approvedPlanMarkdown === "string" ? latest.data.approvedPlanMarkdown : "";
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
