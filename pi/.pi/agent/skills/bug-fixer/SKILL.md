---
name: bug-fixer
description: "Systematic approach to identifying, reproducing, and fixing software bugs. Use when you need to: (1) debug failing tests or unexpected behavior, (2) trace the root cause of errors, (3) fix regressions, (4) analyze stack traces and error logs, or (5) create minimal reproduction cases."
---

# Bug Fixing Workflow

## Process

1. **Reproduce**: Create minimal, standalone reproduction script or test case
2. **Isolate**: Use binary search (`git bisect`), logging, debuggers to find exact cause
3. **Analyze**: Perform root cause analysis (RCA) to understand the underlying failure
4. **Fix**: Implement a fix addressing root cause while preventing regression
5. **Verify**: Run reproduction test and full test suite
6. **Document**: Summarize the fix and behavior changes

## Common Pitfalls to Check

- Race conditions
- Null/undefined references
- Off-by-one errors
- Incorrect type coercion
- Unhandled edge cases
- Resource leaks (memory, file handles, connections)

## Tools

- **Regression tracking**: `git bisect start`, `git bisect good/bad`
- **Debugging**: `gdb`, `pdb`, `node --inspect`, browser DevTools
- **Logging**: Add strategic log points to trace execution flow

## Guidelines

- Read error logs and stack traces carefully before making changes
- Propose refactoring if code is too brittle and prone to similar bugs
- Write a test that fails before the fix and passes after
