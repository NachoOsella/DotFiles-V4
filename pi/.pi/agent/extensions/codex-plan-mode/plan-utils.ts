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

export function isSafePlanModeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
	const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
	return !isDestructive && isSafe;
}

export function extractPlanSteps(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n");
	const headerMatch = normalized.match(/(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:plan|implementation plan|plan de implementaci[oó]n)\s*:?\s*\n/i);
	const section = headerMatch
		? normalized.slice((headerMatch.index ?? 0) + headerMatch[0].length)
		: normalized;

	const steps: string[] = [];
	let blankStreak = 0;

	for (const rawLine of section.split("\n")) {
		const line = rawLine.trimEnd();
		if (line.trim().length === 0) {
			blankStreak += 1;
			if (steps.length > 0 && blankStreak >= 2) break;
			continue;
		}
		blankStreak = 0;

		const numbered = line.match(/^\s*(\d+)[\).:-]\s+(.+)$/);
		if (numbered) {
			steps.push(cleanStep(numbered[2]));
			continue;
		}

		if (steps.length > 0 && /^\s*[-*]\s+/.test(line)) {
			steps.push(cleanStep(line.replace(/^\s*[-*]\s+/, "")));
			continue;
		}

		if (steps.length > 0 && /^\s+/.test(rawLine)) {
			const last = steps.length - 1;
			steps[last] = cleanStep(`${steps[last]} ${line.trim()}`);
			continue;
		}

		if (steps.length > 0 && /^\s{0,3}(#{1,6}\s+|\*\*.+\*\*:?\s*)/.test(line)) {
			break;
		}
	}

	return steps.filter((step, index, arr) => step.length > 0 && arr.indexOf(step) === index);
}

function cleanStep(step: string): string {
	return step
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}
