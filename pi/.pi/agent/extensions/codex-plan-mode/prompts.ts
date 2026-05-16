import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Build hidden mode instruction that makes plan mode produce decision-complete Markdown plans. */
export function buildPlanModePrompt(currentPlan: string): string {
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

/** Carry the previous draft into refinement turns without losing the rich Markdown plan. */
export function buildCurrentPlanContext(lastPlanMarkdown: string, lastPlanSteps: string[]): string {
  if (lastPlanMarkdown.trim()) {
    return `\n\nCurrent draft plan:\n${lastPlanMarkdown.trim()}`;
  }
  if (lastPlanSteps.length === 0) return "";
  return `\n\nCurrent draft execution steps:\n${lastPlanSteps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
}

/** Show the complete plan when available and fall back to legacy numbered steps. */
export function formatPlanForDisplay(planMarkdown: string, planSteps: string[]): string {
  if (planMarkdown.trim()) return planMarkdown.trim();
  if (planSteps.length === 0) return "No plan parsed yet.";
  return planSteps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

/** Wrap legacy step-only plans in a minimal Markdown structure for downstream handling. */
export function buildMarkdownFromSteps(steps: string[]): string {
  const planList = steps.map((step) => `- ${step}`).join("\n");
  return `# Plan\n\n## Implementation Changes\n${planList}`;
}

/** Extract available skill commands to include in the execution kickoff. */
export function getSkillCommandHints(pi: ExtensionAPI): string[] {
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

/** Provide execute mode with both the full approved plan and concise task-derived steps. */
export function buildImplementationKickoffMessage(planSteps: string[], planMarkdown: string, skillHints: string[]): string {
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
