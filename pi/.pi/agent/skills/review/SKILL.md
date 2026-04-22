---
name: review
description: "Reviews codebases or pull requests and provides feedback on correctness, security, performance, maintainability, testing, and documentation. Use when you need to: (1) audit code for potential issues before deployment, (2) review a PR for correctness and security, (3) assess code quality and maintainability, (4) identify missing tests or documentation, or (5) get a second opinion on implementation approaches."
---

## Review Process

1. **Context gathering**: Use `glob`, `grep`, and `read` to understand project structure, conventions, and the scope of changes.
2. **Automated screening**: Run applicable linters via `scripts/` before manual review. Capture output and de-duplicate against manual findings.
3. **Systematic manual review**: Walk through the checklist below, plus any relevant `references/` for the language/framework.
4. **Draft findings**: Record every issue using the concrete output template.
5. **Validation loop**: Self-check each finding against the checklist and gotchas before finalizing.
6. **Finalize**: Sort by severity, ensure at least one specific positive feedback item is present, and deliver.

## Review Checklist

### Correctness
- [ ] Logic errors or edge cases not handled
- [ ] Race conditions or concurrency issues
- [ ] Error handling completeness (nulls, exceptions, rejections)
- [ ] API contract adherence (request/response shapes, status codes)
- [ ] Idempotency and state mutation safety

### Security
- [ ] Input validation and sanitization
- [ ] Authentication/authorization checks
- [ ] Sensitive data exposure (logs, responses, client bundles)
- [ ] Dependency vulnerabilities (outdated or malicious packages)
- [ ] Injection risks (SQL, NoSQL, command, template, XSS)

### Performance
- [ ] Unnecessary database queries (N+1)
- [ ] Memory-intensive operations or leaks
- [ ] Missing caching opportunities
- [ ] Blocking operations on hot paths
- [ ] Bundle size or render performance (frontend)

### Maintainability
- [ ] Code readability and naming
- [ ] Adherence to project conventions
- [ ] DRY principle violations
- [ ] Dead code, commented-out blocks, or unused imports
- [ ] Separation of concerns and module boundaries

### Testing
- [ ] Test coverage for new/changed code
- [ ] Edge cases and failure paths tested
- [ ] Integration or contract tests where needed
- [ ] Flaky test patterns (timing, randomness, shared mutable state)

### Documentation
- [ ] Public API documentation
- [ ] Complex logic explained
- [ ] README or CHANGELOG updates if behavior changes
- [ ] Deployment or configuration notes if needed

## Extended References

See `references/` for deep-dive checklists per language/framework:

- `references/react-hooks.md` — Rules of Hooks, dependency arrays, cleanup, stale closures
- `references/spring-security.md` — Filter chains, CSRF, CORS, method security, secrets handling
- `references/sql-queries.md` — Index usage, injection prevention, transaction boundaries, pagination

Load the relevant reference before starting the manual review phase.

## Automated Linter Scripts

Before manual review, invoke applicable tools from `scripts/`:

- `scripts/run-eslint.sh` — JavaScript/TypeScript
- `scripts/run-pylint.sh` — Python
- `scripts/run-checkstyle.sh` — Java

Capture output, surface new issues, and do not duplicate linter-only style findings in the manual review.

## Concrete Output Template

For every finding, record the following fields:

```
Severity:  Critical | Warning | Info | Positive
Location:  filepath:line (or filepath:line-range)
Problem:   <one-sentence description of what is wrong or risky>
Suggested Fix:
           <concrete code snippet, diff, or step-by-step instruction>
Why:       <brief explanation of impact, risk, or maintainability cost>
```

**Example:**

```
Severity:  Warning
Location:  src/api/users.ts:42
Problem:   Unauthenticated endpoint returns full user records including hashed passwords.
Suggested Fix:
           - Add auth middleware before this route.
           - Strip passwordHash from the response DTO.
Why:       Exposing password hashes increases breach impact and violates OWASP API security guidelines.
```

## Gotchas

- **Do not block a PR solely on style issues if an automated linter already covers them.** Instead, suggest configuring or enforcing the linter in CI. Reserve manual review for correctness, security, performance, and maintainability concerns that linters cannot catch.
- **Always distinguish blocking issues from suggestions.** Label every finding with its severity. Blocking issues must be resolved before merge; suggestions are at the author's discretion.
- **Always give at least one specific positive feedback item.** Cite a concrete file/line and explain what makes it well done. Positive feedback reinforces good patterns and keeps reviews collaborative.
- **Avoid vague nitpicks.** If a comment does not include a Location and a concrete Suggested Fix, it is probably not actionable.
- **Check for false positives.** If a pattern looks suspicious but is intentionally used, verify intent with the author rather than assuming a bug.
- **Scope discipline.** Only review what the PR changes; do not expand scope into unrelated refactoring unless it is a genuine security or correctness risk introduced by the PR.

## Validation Loop

Before finalizing the review, run this self-check against every drafted finding:

1. [ ] Does the finding include a `Location` with filepath and line number?
2. [ ] Is the `Severity` explicit and justified?
3. [ ] Is the `Suggested Fix` concrete enough that the author can apply it without guessing?
4. [ ] Does the `Why` explain impact rather than personal preference?
5. [ ] If this is a style issue, is the project linter *not* already catching it?
6. [ ] Is this finding within the PR's changed scope?
7. [ ] Have I included at least one `Positive` finding?

Only publish the review after all applicable checks pass.
