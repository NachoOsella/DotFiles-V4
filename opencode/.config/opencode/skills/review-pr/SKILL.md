---
name: review-pr
description: High-signal GitHub pull request review focused on merge safety, correctness, readability, simplicity, maintainability, tests, and repository fit. Produces an actionable review plus a self-contained Vercel-style HTML mergeability report.
---

# Review PR

Review a pull request as a maintainer deciding whether this code should live in the repository for years.

The goal is not to maximize comments. The goal is to answer:

> Is this change correct, safe, easy to understand, appropriately simple, well tested, consistent with the repository, and ready to merge?

Always finish by generating a visual HTML report from `report-template.html`.

## Principles

- Review the change, not unrelated pre-existing debt.
- Prefer a few high-confidence findings over many speculative ones.
- CI owns formatting, lint and mechanical checks. Spend reasoning on what tools miss.
- Readability is a feature. Code should explain itself through names, structure and control flow.
- Prefer the simplest design that cleanly handles the actual requirements.
- Patterns are tools, not goals. Flag unnecessary factories, interfaces, layers, wrappers, indirection or premature extensibility.
- Respect repository conventions and current architecture. Do not force generic "best practices" that make this codebase less coherent.
- New abstractions must pay for themselves by reducing duplication, coupling, branching or future change cost.
- Comments should explain non-obvious *why*, not narrate obvious code.
- Tests should protect meaningful behavior and edge cases, not inflate coverage with duplicate cases.
- Never approve because code "looks fine". Verify the important paths.
- Never block on taste alone.

## 1. Resolve the PR and repository context

Accept a PR URL, PR number, or infer the PR associated with the current branch.

Prefer GitHub tooling when available. `gh` equivalents:

```bash
gh pr view <pr> --json number,title,body,url,author,baseRefName,headRefName,additions,deletions,changedFiles,commits,mergeable,reviewDecision,statusCheckRollup
gh pr diff <pr>
gh pr view <pr> --json files
```

Before judging the diff, read the relevant repository guidance when present:

- `AGENTS.md`
- `CONTRIBUTING.md`
- `README.md` sections that define architecture or conventions
- language/framework config and lint rules
- a local `review-pr-local` skill or equivalent
- specs/issues referenced by the PR description

Use recent code in the same subsystem as the strongest style/architecture precedent. Do not copy legacy patterns merely because they exist.

Do not mutate the user's working tree just to review a PR. If deeper local context is required and the PR branch is not checked out, prefer a temporary worktree or read the necessary files from the appropriate refs.

## 2. Understand intent before implementation

Write a short internal statement of:

- what behavior the PR intends to add/change/remove
- what components and contracts it touches
- what could break if the implementation is wrong
- what is explicitly out of scope

If the PR description references an issue/spec, compare implementation against it. Material spec drift is a finding even when the code itself is internally consistent.

## 3. Triage the diff

Skip or de-prioritize generated, vendored, minified, lock and build-output files unless the PR is specifically about them.

Group changed files by concern, then choose only the review passes that matter:

- correctness and behavior: always
- maintainability and simplicity: always for code
- tests: when behavior changes
- compatibility/API/data: when contracts, schemas, persistence or public APIs change
- security: auth, permissions, secrets, parsing, uploads, network boundaries, crypto, untrusted input
- concurrency/reliability: async work, queues, retries, transactions, locks, distributed flows
- performance: hot paths, large data, loops, queries, rendering, allocations, network chatter
- UX/accessibility: user-facing UI changes

If subagents are available, use them selectively for independent passes. Do not fan out by default. Give each reviewer the PR intent, relevant diff and repository rules. The main reviewer must verify and deduplicate every returned finding.

## 4. Review the implementation

### Correctness

Trace the changed behavior end to end.

Look for:

- wrong conditions, state transitions or ordering
- broken null/empty/error paths
- off-by-one and boundary errors
- stale state or partial updates
- incorrect assumptions about callers or data
- lost errors, swallowed exceptions or misleading fallbacks
- race conditions, transaction problems or non-idempotent retries
- backwards-incompatible behavior that is not intentional
- behavior that satisfies the happy path but not the requirement

A correctness finding must explain the concrete failure mode.

### Readability and self-explanatory code

Good code should be understandable without reverse-engineering it.

Check that:

- names reveal domain intent rather than implementation trivia
- functions/methods have one coherent reason to change
- control flow is easy to follow, with early exits when they reduce nesting
- important business rules are visible instead of hidden behind generic helpers
- types and boundaries make invalid states harder to represent when practical
- comments explain reasons, constraints or surprising behavior
- duplicated domain logic is centralized when doing so genuinely reduces drift

Do not demand tiny functions, comments, DTOs, interfaces or abstractions by default. Judge whether the current structure is easier to read and change.

### Simplicity and design

Actively search for accidental complexity.

Flag:

- abstractions with one implementation and no meaningful boundary
- factories/builders/strategies introduced without a real variation point
- pass-through service/repository layers that add no policy
- generic helpers that hide a simple domain operation
- configuration or extensibility added for hypothetical future requirements
- duplicated concepts represented by multiple sources of truth
- deep dependency chains caused by avoidable indirection
- design patterns applied ceremonially

Reward changes that delete complexity, narrow APIs, improve cohesion, reduce coupling, or make ownership clearer.

Use a design pattern only when it solves a visible problem in this repository. Prefer boring code that is obvious over clever code that needs explanation.

### Repository fit and maintainability

Check whether the change:

- follows established module and dependency direction
- places responsibility in the correct component
- keeps public APIs and domain concepts consistent
- uses the repository's current preferred patterns
- avoids leaking persistence/framework details across boundaries
- can be modified later without touching unrelated modules
- does not create a second competing way to solve the same problem

If nearby code is inconsistent, prefer the pattern supported by current docs, recent code and active architecture.

### Tests

Tests should make the change safer to maintain.

Verify:

- changed behavior has meaningful coverage
- failure/edge paths are covered where they can realistically regress
- assertions test outcomes, not implementation trivia
- mocks do not make the test tautological
- tests remain deterministic and isolated
- a refactor that preserves behavior does not require pointless new tests
- new tests would actually fail if the suspected bug existed

Run the smallest relevant test/build/lint commands when practical. Record exactly what was and was not executed.

### Security, performance and reliability

Only perform deep passes when the diff makes them relevant.

Do not invent hypothetical vulnerabilities or micro-optimizations. Report a concern when you can connect changed code to a realistic attack, failure or cost.

## 5. Validate findings

Before keeping any finding, require all of these:

1. The PR introduced it or made it materially worse.
2. You can point to a changed file and relevant line/range.
3. You can explain the concrete consequence.
4. The concern is not already handled elsewhere in the changed flow.
5. The fix would improve the repository rather than merely reflect personal taste.

Re-read surrounding code for every BLOCKER or HIGH finding.

Combine findings with the same root cause.

Severity:

- `BLOCKER`: unsafe to merge. Definite correctness/security/data-loss/breaking issue, or required CI is failing for this change.
- `HIGH`: significant bug, maintainability trap, missing critical behavior test, or architecture violation likely to cause real problems.
- `MEDIUM`: real issue worth fixing, but merge may still be reasonable depending on scope.
- `NIT`: small cleanup with clear value. Never let nits dominate a review.

Do not post comments or submit a GitHub review unless the user explicitly asks.

## 6. Judge what the PR adds to the repository

Record both positive and negative impact.

Positive examples:

- simplifies an existing flow
- removes duplication or dead code
- makes ownership/boundaries clearer
- improves names or type safety
- adds useful tests
- reduces coupling
- replaces brittle logic with an established repo pattern

Negative examples:

- increases cognitive load
- introduces extra layers or concepts
- duplicates an existing mechanism
- creates a new dependency direction
- adds fragile tests
- expands API surface unnecessarily
- makes simple behavior harder to trace

Praise only concrete improvements. Avoid generic compliments.

## 7. Mergeability score

Score the PR from 0-100. This is a merge-confidence score, not a vanity code-quality score.

Dimensions:

| Dimension | Weight |
| --- | ---: |
| Correctness | 30 |
| Maintainability/readability | 20 |
| Simplicity/design | 15 |
| Tests/verification | 15 |
| Safety/reliability | 10 |
| Repository fit/compatibility | 10 |

Use evidence from the diff, surrounding code and executed checks.

Hard caps:

- confirmed critical security, corruption or data-loss bug: max `30`
- definite functional blocker or broken required contract: max `49`
- required CI/build failing because of this PR: max `59`
- important behavior changed with clearly inadequate verification: max `74`

Do not lower the score merely because you could not run every check. Report lower confidence instead.

Verdict:

- `READY`: 90-100, no BLOCKER/HIGH findings, required checks pass
- `READY_WITH_NOTES`: 80-89, no BLOCKER, remaining issues are non-blocking
- `NEEDS_CHANGES`: below 80 or any unresolved HIGH that should be fixed before merge
- `BLOCKED`: unresolved BLOCKER, required checks failing, or merge state prevents a safe decision

A score never overrides a blocker.

## 8. Final output

First give the user a concise textual review:

1. verdict + mergeability score
2. blockers/high findings first
3. important positives
4. checks/tests actually run
5. path to the generated HTML report

Then generate the HTML report.

### HTML report contract

Use the `report-template.html` located next to this `SKILL.md`. Do not redesign it for each review.

Create a copy named:

```text
pr-review-<number-or-branch>.html
```

Prefer `.artifacts/` in the repository root; create it if needed.

Inject one JSON object between these exact markers in the template:

```js
/*__REVIEW_DATA_START__*/
{ ... }
/*__REVIEW_DATA_END__*/
```

Do not inject HTML fragments. The template renders all user-controlled text safely.

Use this schema:

```json
{
  "meta": {
    "repo": "owner/repo",
    "number": 123,
    "title": "PR title",
    "url": "https://github.com/...",
    "author": "name",
    "base": "main",
    "head": "feature",
    "additions": 120,
    "deletions": 40,
    "files": 8,
    "generatedAt": "ISO-8601"
  },
  "verdict": {
    "state": "READY | READY_WITH_NOTES | NEEDS_CHANGES | BLOCKED",
    "score": 86,
    "confidence": "high | medium | low",
    "headline": "One-sentence maintainer judgment"
  },
  "dimensions": [
    {"label":"Correctness","score":27,"max":30,"summary":"..."}
  ],
  "checks": [
    {"name":"unit tests","status":"pass | fail | not_run | unknown","detail":"..."}
  ],
  "positives": [
    {"title":"Clearer ownership","detail":"Why this improves the repo","path":"optional/path"}
  ],
  "findings": [
    {
      "severity":"BLOCKER | HIGH | MEDIUM | NIT",
      "title":"Short finding",
      "path":"src/file.ts",
      "line":42,
      "impact":"Concrete consequence",
      "recommendation":"Specific fix direction"
    }
  ],
  "changedAreas": ["auth", "persistence"],
  "summary": "2-4 sentence overall assessment"
}
```

Always include all six score dimensions, even if one has little relevance. Explain that briefly in its summary.

Before finishing, verify:

- score and verdict agree with blockers
- every finding is supported by the diff
- positives are specific
- executed checks are reported honestly
- HTML opens as a self-contained file with no network dependency

## 9. Open the report automatically

After generating and validating the HTML report, open it automatically in the user's default browser so the review is immediately visible.

Use the current platform:

```bash
# Linux
xdg-open ".artifacts/pr-review-<number-or-branch>.html"

# macOS
open ".artifacts/pr-review-<number-or-branch>.html"

# Windows
start "" ".artifacts/pr-review-<number-or-branch>.html"
```

Prefer the native platform command and run it only after the report file exists.

If the environment is headless, remote, sandboxed, or opening a browser fails:

- do not treat that as a review failure
- keep the generated HTML report
- clearly print the absolute path to the report
- do not retry in a loop or install GUI/browser dependencies

The final user-facing response should mention that the report was opened automatically when successful. Otherwise, provide the report path so it can be opened manually.
