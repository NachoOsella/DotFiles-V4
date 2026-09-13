# Code review and generated-code quality rules

Use for reviewing a diff or module, cleaning generated code, or deciding whether a
change is mergeable.

## Review order

Prioritize findings in this order:

1. correctness and data loss;
2. security and authorization;
3. transaction and concurrency correctness;
4. persistence and query behavior;
5. API compatibility and validation;
6. resource and lifecycle failures;
7. maintainability and architecture;
8. performance supported by evidence;
9. style.

Do not bury a transaction or authorization defect under naming comments.

## Findings need evidence

Every finding should identify:

- file and line or range when available;
- concrete behavior or risk in this repository;
- why it matters;
- the smallest viable fix;
- severity.

Use these severities:

- Critical: exploitable security/data loss or guaranteed catastrophic behavior.
- High: likely production bug, authorization flaw, or broken transaction/data behavior.
- Medium: bounded correctness, maintainability, or measured performance risk worth fixing.
- Low: concrete hygiene or readability debt.
- Info: optional improvement with no clear defect.

Mark uncertainty and required verification instead of presenting guesses as defects.

## Generated-code smells

Look especially for:

- unnecessary interfaces plus `Impl`, pass-through managers/facades, and generic base
  layers;
- one mapper/DTO/wrapper per layer with no semantic difference;
- catch-all exceptions returning null/false and duplicated exception logging;
- field injection or Lombok annotations that hide entity/invariant semantics;
- EAGER mappings, `@Transactional` everywhere, or `@SpringBootTest` for trivial logic;
- reactive wrappers around blocking JPA;
- speculative caching, retries, concurrency, builders, or helper frameworks;
- utility classes with unrelated methods, restatement comments, placeholder code, and
  abstractions created before a real second use case.

Do not report a smell merely because its name matches this list. Show its cost in the
reviewed code.

## Refactor policy

- Prefer the smallest change that removes the defect.
- Preserve behavior unless change is requested.
- Do not turn a review into a repository-wide modernization.
- Add or adjust tests with behavior-sensitive refactors.
- Separate an immediate safe fix from a larger optional architecture change.
- Consult a concern-specific rule only after a concrete finding requires it; do not load
  all rules as a review checklist.

## Finding format

```text
[severity] path/File.java:line - short title
Why: concrete failure or risk.
Fix: smallest specific change.
```

For a clean review, state what was checked and that no material finding was found. Do not
invent minor comments to fill space.

## Check

Confirm every finding is evidenced, prioritized by impact, and independent of personal
style preference.
