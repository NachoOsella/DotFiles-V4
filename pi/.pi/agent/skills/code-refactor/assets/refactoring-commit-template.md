# Refactoring Commit Message Template

Use this template when committing pure refactoring changes.

```
refactor(scope): <short description>

<what changed and why>

<measurement or observation (optional)>
- Before: <metric>
- After: <metric>

Refs: <ticket or PR>
```

## Examples

```
refactor(billing): extract payment validation from process_order

process_order was 85 lines and handled validation, calculation, and
notification. Extracted validate_payment() to isolate card-check logic
and reduce method length.

- Before: process_order 85 lines, nesting depth 5
- After: process_order 35 lines, validate_payment 28 lines

Refs: #142
```

```
refactor(auth): replace role switch with UserRole polymorphism

Replaced repeated switch statements on role strings with UserRole
abstractions. Eliminates 3 duplicate blocks across LoginService,
PermissionChecker, and AuditLogger.

- Before: 4 switch/case blocks, 42 lines total
- After: 4 role classes, 38 lines total, zero switches

Refs: #198
```

## Checklist

- [ ] Tests pass before and after
- [ ] No public API signatures changed (or documented if they did)
- [ ] Commit is purely refactoring (no behavior changes)
- [ ] Metric or observable improvement noted
