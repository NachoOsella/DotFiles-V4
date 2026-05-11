const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS: RegExp[] = [
	/^\s*cat\b/i,
	/^\s*head\b/i,
	/^\s*tail\b/i,
	/^\s*less\b/i,
	/^\s*more\b/i,
	/^\s*grep\b/i,
	/^\s*find\b/i,
	/^\s*ls\b/i,
	/^\s*pwd\b/i,
	/^\s*echo\b/i,
	/^\s*printf\b/i,
	/^\s*wc\b/i,
	/^\s*sort\b/i,
	/^\s*uniq\b/i,
	/^\s*diff\b/i,
	/^\s*file\b/i,
	/^\s*stat\b/i,
	/^\s*du\b/i,
	/^\s*df\b/i,
	/^\s*tree\b/i,
	/^\s*which\b/i,
	/^\s*whereis\b/i,
	/^\s*type\b/i,
	/^\s*env\b/i,
	/^\s*printenv\b/i,
	/^\s*uname\b/i,
	/^\s*whoami\b/i,
	/^\s*id\b/i,
	/^\s*date\b/i,
	/^\s*cal\b/i,
	/^\s*uptime\b/i,
	/^\s*ps\b/i,
	/^\s*top\b/i,
	/^\s*htop\b/i,
	/^\s*free\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/i,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/i,
	/^\s*rg\b/i,
	/^\s*fd\b/i,
	/^\s*bat\b/i,
	/^\s*exa\b/i,
];

const EXECUTION_SECTION_PATTERN = /^(implementation|implementation changes|key changes|changes|test plan|validation|verification|tests?)$/i;
const IGNORED_STEP_PREFIX_PATTERN = /^(summary|assumptions?|defaults?|risks?|edge cases?|scope)\b/i;

export interface ParsedPlan {
	markdown: string;
	steps: string[];
}

// Ensures plan mode exploration cannot execute commands that mutate the workspace or system.
export function isSafePlanModeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
	const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
	return !isDestructive && isSafe;
}

// Parses the full Markdown plan and derives concise execution steps for todo import.
export function parsePlan(text: string): ParsedPlan {
	const markdown = extractPlanMarkdown(text);
	const steps = extractPlanStepsFromMarkdown(markdown || text);
	return { markdown, steps };
}

// Backward-compatible step extraction for callers that only need executable items.
export function extractPlanSteps(text: string): string[] {
	return parsePlan(text).steps;
}

// Extracts plain Markdown plans while keeping legacy proposed_plan and Plan: output supported.
function extractPlanMarkdown(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n");
	const tagStart = String.fromCharCode(60);
	const tagEnd = String.fromCharCode(62);
	const proposedPlanPattern = `${tagStart}proposed_plan${tagEnd}\\s*\\n?([\\s\\S]*?)\\n?\\s*${tagStart}\\/proposed_plan${tagEnd}`;
	const proposedPlan = normalized.match(new RegExp(proposedPlanPattern, "i"));
	if (proposedPlan?.[1]?.trim()) return proposedPlan[1].trim();

	const markdownPlan = normalized.match(/(?:^|\n)\s{0,3}#{1,6}\s+(?:plan|implementation plan|plan de implementaci[oó]n)\s*\n[\s\S]*/i);
	if (markdownPlan) return normalized.slice(markdownPlan.index ?? 0).trim();

	const headerMatch = normalized.match(/(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:plan|implementation plan|plan de implementaci[oó]n)\s*:?\s*\n/i);
	if (!headerMatch) return "";

	return normalized.slice((headerMatch.index ?? 0) + headerMatch[0].length).trim();
}

// Derives todo-worthy steps from implementation and validation sections before using a broad fallback.
function extractPlanStepsFromMarkdown(markdown: string): string[] {
	const sectionSteps = extractSectionSteps(markdown);
	if (sectionSteps.length > 0) return sectionSteps;

	return extractListItems(markdown).filter((step) => !IGNORED_STEP_PREFIX_PATTERN.test(step));
}

function extractSectionSteps(markdown: string): string[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const steps: string[] = [];
	let inExecutionSection = false;

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
		if (heading) {
			inExecutionSection = EXECUTION_SECTION_PATTERN.test(cleanHeading(heading[1]));
			continue;
		}

		if (!inExecutionSection) continue;
		const listItem = parseListItem(line);
		if (listItem) steps.push(listItem);
	}

	return uniqueSteps(steps);
}

function extractListItems(markdown: string): string[] {
	const steps: string[] = [];

	for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
		const listItem = parseListItem(rawLine.trimEnd());
		if (listItem) steps.push(listItem);
	}

	return uniqueSteps(steps);
}

function parseListItem(line: string): string | undefined {
	const numbered = line.match(/^\s*(\d+)[\).:-]\s+(.+)$/);
	if (numbered) return cleanStep(numbered[2]);

	const bullet = line.match(/^\s*[-*]\s+(.+)$/);
	if (bullet) return cleanStep(bullet[1]);

	return undefined;
}

function uniqueSteps(steps: string[]): string[] {
	return steps.filter((step, index, arr) => step.length > 0 && arr.indexOf(step) === index);
}

function cleanHeading(heading: string): string {
	return heading
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[:：]\s*$/g, "")
		.trim();
}

function cleanStep(step: string): string {
	return step
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}
