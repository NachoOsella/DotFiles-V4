import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptEntry, UsageSnapshot } from "../src/domain/goal.ts";
import {
    addUsageTotals,
    chargeableTokens,
    deriveUsage,
    emptyUsageTotals,
} from "../src/services/usage-accounting.ts";

function makeUsage(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...overrides };
}

function messageEntry(
    id: string,
    role: string,
    extra: Partial<{
        usage: UsageSnapshot;
    }> = {},
): TranscriptEntry {
    return { type: "message", id, message: { role, ...extra } };
}

function assistant(id: string, usage: UsageSnapshot): TranscriptEntry {
    return messageEntry(id, "assistant", { usage });
}

function topLevelUsageEntry(id: string, type: string, usage: UsageSnapshot): TranscriptEntry {
    return { type, id, usage };
}

test("empty totals are all zero", () => {
    assert.deepEqual(emptyUsageTotals(), {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        tokensUsed: 0,
        allTokens: 0,
        costTotal: 0,
    });
});

test("addUsageTotals sums every bucket", () => {
    const left = { ...emptyUsageTotals(), input: 1, cacheRead: 2, tokensUsed: 3, costTotal: 0.5 };
    const right = { ...emptyUsageTotals(), input: 4, cacheRead: 5, tokensUsed: 6, costTotal: 0.25 };
    assert.deepEqual(addUsageTotals(left, right), {
        input: 5,
        output: 0,
        cacheRead: 7,
        cacheWrite: 0,
        reasoning: 0,
        tokensUsed: 9,
        allTokens: 0,
        costTotal: 0.75,
    });
});

test("chargeable tokens exclude cache reads and clamp negatives", () => {
    assert.equal(chargeableTokens(makeUsage({ input: 10, output: 50, cacheRead: 1000 })), 60);
    assert.equal(
        chargeableTokens(makeUsage({ input: -10, output: 5, cacheRead: 100, cacheWrite: 2 })),
        7,
    );
    assert.equal(
        chargeableTokens(makeUsage({ input: Number.NaN, output: Number.POSITIVE_INFINITY })),
        0,
    );
});

test("anchor entry and earlier usage are not charged", () => {
    const branch = [
        assistant("before", makeUsage({ input: 100, output: 50 })),
        assistant("anchor", makeUsage({ input: 1000, output: 1000 })),
        assistant("after", makeUsage({ input: 10, output: 5 })),
    ];

    const totals = deriveUsage({ branch, usageStartEntryId: "anchor" });

    assert.equal(totals.input, 10);
    assert.equal(totals.output, 5);
    assert.equal(totals.tokensUsed, 15);
    assert.equal(totals.allTokens, 15);
});

test("charges the whole branch when the anchor is null or absent", () => {
    const branch = [
        assistant("first", makeUsage({ input: 10, output: 5 })),
        assistant("second", makeUsage({ input: 1, output: 1 })),
    ];

    const unbounded = deriveUsage({ branch, usageStartEntryId: null });
    assert.equal(unbounded.input, 11);
    assert.equal(unbounded.output, 6);

    const missing = deriveUsage({ branch, usageStartEntryId: "not-on-this-branch" });
    assert.equal(missing.input, 11);
    assert.equal(missing.output, 6);
});

test("counts assistant, tool result, usage, compaction, and branch summary entries", () => {
    const branch: TranscriptEntry[] = [
        messageEntry("user", "user"),
        assistant(
            "assistant",
            makeUsage({
                input: 10,
                output: 5,
                cacheRead: 100,
                cacheWrite: 2,
                reasoning: 3,
                cost: { total: 0.5 },
            }),
        ),
        messageEntry("tool-result", "toolResult", {
            usage: makeUsage({ input: 4, output: 1, cost: { total: 0.25 } }),
        }),
        topLevelUsageEntry("cache-warm", "usage", makeUsage({ input: 1, cacheRead: 50 })),
        topLevelUsageEntry(
            "compaction",
            "compaction",
            makeUsage({ input: 2, output: 2, cacheWrite: 1 }),
        ),
        topLevelUsageEntry("summary", "branch_summary", makeUsage({ input: 3, output: 1 })),
    ];

    const totals = deriveUsage({ branch, usageStartEntryId: null });

    assert.deepEqual(totals, {
        input: 20,
        output: 9,
        cacheRead: 150,
        cacheWrite: 3,
        reasoning: 3,
        tokensUsed: 32,
        allTokens: 182,
        costTotal: 0.75,
    });
});

test("duplicate entry ids are counted once", () => {
    const branch = [
        assistant("dup", makeUsage({ input: 10, output: 5 })),
        assistant("dup", makeUsage({ input: 10, output: 5 })),
    ];

    const totals = deriveUsage({ branch, usageStartEntryId: null });

    assert.equal(totals.input, 10);
    assert.equal(totals.output, 5);
    assert.equal(totals.tokensUsed, 15);
});

test("cache reads count towards allTokens but not towards tokensUsed", () => {
    const branch = [assistant("turn", makeUsage({ input: 10, output: 50, cacheRead: 1000 }))];

    const totals = deriveUsage({ branch, usageStartEntryId: null });

    assert.equal(totals.tokensUsed, 60);
    assert.equal(totals.allTokens, 1060);
});

test("negative and non-finite values are ignored", () => {
    const branch = [
        assistant(
            "bad",
            makeUsage({
                input: -5,
                output: Number.NaN,
                cacheRead: -100,
                cacheWrite: -1,
                reasoning: Number.NaN,
                cost: { total: -0.5 },
            }),
        ),
    ];

    const totals = deriveUsage({ branch, usageStartEntryId: null });

    assert.deepEqual(totals, emptyUsageTotals());
});

test("cost totals are summed", () => {
    const branch = [
        assistant("one", makeUsage({ input: 1, cost: { total: 0.25 } })),
        assistant("two", makeUsage({ input: 2, cost: { total: 0.75 } })),
    ];

    const totals = deriveUsage({ branch, usageStartEntryId: null });

    assert.equal(totals.costTotal, 1);
});

test("a total-only usage record is charged from the reported total", () => {
    const onlyTotal: UsageSnapshot = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1000,
    };
    const branch: TranscriptEntry[] = [
        { type: "usage", id: "u1", usage: onlyTotal },
    ];
    const totals = deriveUsage({ branch, usageStartEntryId: null });
    assert.equal(totals.tokensUsed, 1000);
    assert.equal(totals.input, 1000);
    assert.equal(totals.allTokens, 1000);
});

test("cache warming usage is not charged to the goal", () => {
    const branch: TranscriptEntry[] = [
        {
            type: "usage",
            id: "warm",
            usage: makeUsage({ input: 500, cacheWrite: 100 }),
            kind: "cache_warm",
        },
    ];
    const totals = deriveUsage({ branch, usageStartEntryId: null });
    assert.equal(totals.tokensUsed, 0);
});
