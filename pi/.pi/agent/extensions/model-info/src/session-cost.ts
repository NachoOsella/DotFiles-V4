import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function finiteCostTotal(usage: Usage | undefined): number {
  if (!usage || typeof usage !== "object") return 0;
  const total = (usage as { cost?: { total?: unknown } }).cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message") {
    const message = entry.message;
    // Assistant messages carry the main LLM cost; tool-result messages can
    // carry nested LLM-work usage (e.g. deferred/subagent tool execution).
    if (message.role === "assistant") return message.usage;
    if (message.role === "toolResult") return message.usage;
    return undefined;
  }
  // Summary-generation LLM calls are billed usage too. Count the entry's own
  // usage only; never traverse compaction.retainedTail, which materializes
  // already-counted branch messages as a context checkpoint.
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage;
  }
  return undefined;
}

/**
 * Active-branch cost accounting.
 *
 * Sums every usage-bearing entry on the active branch exactly once: assistant
 * messages, tool-result usage, compaction summary usage, and branch-summary
 * usage. Scope is deliberately the active branch (footer "current branch"
 * semantics), NOT lifetime billing across all entries, and NOT child-branch
 * totals. Compaction `retainedTail` is never traversed as separately billed
 * messages. Non-finite cost totals are ignored.
 */
export function computeActiveBranchCost(
  entries: readonly SessionEntry[],
): number {
  let cost = 0;
  for (const entry of entries) {
    cost += finiteCostTotal(entryUsage(entry));
  }
  return cost;
}
