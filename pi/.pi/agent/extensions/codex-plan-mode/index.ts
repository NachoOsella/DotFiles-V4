import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { parsePlan, isSafePlanModeCommand } from "./plan-utils.js";
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

// Builds the hidden mode instruction that makes plan mode produce decision-complete Markdown plans.
function buildPlanModePrompt(currentPlan: string): string {
	return `[CODEX-STYLE PLAN MODE]
You are in planning mode. Explore and design, but do not implement.

Mode rules:
- Allowed tools: read, bash, grep, find, ls, request_user_input, web_search, code_search, fetch_content, get_search_content.
- Forbidden tools: edit, write.
- Use non-mutating exploration first to ground the plan in real files, configs, docs, and constraints. Use web_search and code_search to research APIs, libraries, docs, and real-world usage before deciding.
- Ask the user only for high-impact preferences or decisions that cannot be discovered from the environment.
- Keep refining until the plan is decision-complete enough for another engineer or agent to implement without guessing.

Clarification rules:
- Never guess or silently choose defaults for unclear product, UX, API, safety, scope, or tradeoff decisions.
- If any relevant doubt remains after exploration, stop and call request_user_input before writing the final plan.
- Use request_user_input even for a single important doubt; provide 2-4 realistic options and mark the recommended option in its description when helpful.
- Do not include an Assumptions section to hide unresolved decisions; resolve them through questions first.

Final plan format:
- When ready, output a normal Markdown plan without XML or custom tags.
- Start with a Markdown heading such as # Plan or # Implementation Plan.
- Include 3-5 useful sections, usually Summary, Implementation Changes, Test Plan, and Decisions Confirmed.
- Include enough intent and implementation detail to explain what will change and why.
- Keep execution bullets concise, but do not collapse the plan into a bare checklist.
- Do not ask whether to proceed inside the final plan.${currentPlan}
Do not implement yet; planning only.`;
}

// Carries the previous draft into refinement turns without losing the rich Markdown plan.
function buildCurrentPlanContext(lastPlanMarkdown: string, lastPlanSteps: string[]): string {
	if (lastPlanMarkdown.trim()) {
		return `\n\nCurrent draft plan:\n${lastPlanMarkdown.trim()}`;
	}
	if (lastPlanSteps.length === 0) return "";
	return `\n\nCurrent draft execution steps:\n${lastPlanSteps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`;
}

// Shows the complete plan when available and falls back to legacy numbered steps.
function formatPlanForDisplay(planMarkdown: string, planSteps: string[]): string {
	if (planMarkdown.trim()) return planMarkdown.trim();
	if (planSteps.length === 0) return "No plan parsed yet.";
	return planSteps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

// Wraps legacy step-only plans in a minimal Markdown structure for consistent downstream handling.
function buildMarkdownFromSteps(steps: string[]): string {
	const planList = steps.map((step) => `- ${step}`).join("\n");
	return `# Plan\n\n## Implementation Changes\n${planList}`;
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

// Provides execute mode with both the full approved plan and concise task-derived steps.
function buildImplementationKickoffMessage(planSteps: string[], planMarkdown: string, skillHints: string[]): string {
	const planList = planSteps.map((step, index) => `${index + 1}. ${step}`).join("\n");
	const markdownSection = planMarkdown.trim() ? `Approved Markdown plan:\n${planMarkdown.trim()}\n\n` : "";
	const skillLine =
		skillHints.length > 0
			? `Available skill commands: ${skillHints.join(", ")}.`
			: "Identify required skills and actively look for matching /skill:* commands before coding.";

	return `[IMPLEMENTATION KICKOFF]
${markdownSection}Derived execution steps:
${planList}

Execution protocol (must follow):
1) Before coding, determine which skills are needed for the plan and apply them explicitly. ${skillLine}
2) Then implement step-by-step, following the execution steps above.
3) If implementation reveals missing info, ask follow-up clarifications and refine the plan.`;
}

function looksLikeImplementationDecisionPrompt(text: string): boolean {
	const normalized = text.toLowerCase();
	return [
		"implement this plan",
		"stay in plan mode",
		"refine the plan",
		"proceed with implementation",
		"seguir refinando",
		"ajustar algo del plan",
	]
		.some((token) => normalized.includes(token));
}
