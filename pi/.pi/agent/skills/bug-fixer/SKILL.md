---
name: bug-fixer
description: "Systematic approach to identifying, reproducing, and fixing software bugs. Use when you need to: (1) debug failing tests or unexpected behavior, (2) trace the root cause of errors, (3) fix regressions, (4) analyze stack traces and error logs, or (5) create minimal reproduction cases."
---

# Bug Fixing Workflow

## Process

1. **Reproduce**: Create a minimal, standalone reproduction script or test case that demonstrates the failure.
2. **Isolate**: Use binary search (`git bisect`), logging, and debuggers to pinpoint the exact commit or code path causing the issue.
3. **Analyze**: Perform root cause analysis (RCA) to understand the underlying failure mechanism.
4. **Fix**: Implement a fix that addresses the root cause and prevents regression.
5. **Verify**: Run the reproduction test and the full test suite.
6. **Document**: Summarize the fix, behavior changes, and any architectural notes.

## Validation Loop

Before declaring a bug fixed, enforce this validation loop:

1. **Reproduction test must FAIL before the fix.** If the test passes before the fix, the reproduction is invalid or the bug is not understood.
2. **Reproduction test must PASS after the fix.** The fix must directly resolve the demonstrated failure.
3. **Full suite must pass.** The fix must not introduce regressions in existing functionality.

> Do not skip the full suite run. Local fixes often have unintended side effects in distant modules.

## Tools

- **Regression tracking**: `git bisect` (see `scripts/bisect-automation.sh` for automation)
- **Debugging**: `gdb`, `pdb`, `node --inspect`, browser DevTools, `delve`
- **Logging**: Add strategic log points to trace execution flow; use `scripts/minimal-case-generator.py` to distill logs into a minimal reproduction case
- **Pattern reference**: See `references/debugging-patterns.md` for language-specific debugging tactics and anti-patterns

## Guidelines

- Read error logs and stack traces carefully before making changes. Do not guess.
- If the code is too brittle and prone to similar bugs, propose refactoring alongside the fix.
- Write a test that fails before the fix and passes after. Commit the test separately before the fix when possible.
- Use the provided bisect automation script for regressions to save time.
- Check the gotchas below before finalizing a root cause hypothesis.

## Language/Framework Gotchas

### JavaScript / TypeScript

**Closure loops (stale iteration variable)**

`var` in a loop creates a single shared binding. Callbacks scheduled inside the loop capture the same variable, leading to every callback seeing the final value.

```javascript
// BUG: All timeouts log the same final value of i
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 10);
}
// Output: 3, 3, 3

// FIX: Use let (block-scoped) or an IIFE
for (let i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 10);
}
// Output: 0, 1, 2
```

- Prefer `let`/`const` in loops that create closures.
- Watch for the same pattern in `Array.prototype.map` with `async` callbacks.

### Java

**Optional misuse (antipatterns)**

`Optional` is not a general-purpose null replacement. Misusing it creates harder-to-read code and can hide nulls rather than eliminate them.

```java
// BAD: Optional field, optional parameter, or Optional.get() without check
public class User {
    private Optional<String> middleName; // Do not use Optional as a field
}

// BAD: Unconditional get()
String value = optional.get(); // NoSuchElementException risk

// GOOD: Provide defaults or branch explicitly
String value = optional.orElse("default");
optional.ifPresent(v -> process(v));

// GOOD: Chain transformations safely
return fetchUser(id)
    .flatMap(User::getEmail)
    .map(String::toLowerCase)
    .orElseThrow(() -> new NotFoundException("Missing email"));
```

- Never use `Optional.get()` unless you have just checked `isPresent()`.
- Do not use `Optional` in fields, method parameters, or collections.

### Python

**Iterator off-by-one and exhaustion**

Python iterators can only be traversed once. Reusing an exhausted iterator silently produces no items, leading to subtle bugs.

```python
# BUG: Second loop does nothing because the iterator is exhausted
items = filter(lambda x: x > 0, [-1, 2, 3])
first = list(items)
second = list(items)  # second == []

# FIX: Materialize to a list or tuple if you need multiple passes
items = list(filter(lambda x: x > 0, [-1, 2, 3]))
first = [x for x in items]
second = [x for x in items]

# BUG: Modifying a list while iterating over it skips elements
nums = [1, 2, 3, 4]
for n in nums:
    if n % 2 == 0:
        nums.remove(n)  # Skips the element after a removal
# nums == [1, 3]

# FIX: Iterate over a copy or build a new list
nums = [n for n in nums if n % 2 != 0]
```

- Treat `filter`, `map`, `zip`, and file objects as single-pass.
- When in doubt, `list()` the result before reuse.

## Scripts

- `scripts/bisect-automation.sh` — Automates `git bisect` with a reproduction test script.
- `scripts/minimal-case-generator.py` — Parses logs and stack traces to scaffold a minimal reproduction case.

## References

- `references/debugging-patterns.md` — Detailed debugging patterns, anti-patterns, and tactics organized by language and framework.
