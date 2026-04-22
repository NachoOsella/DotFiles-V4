# Debugging Patterns Catalog

This reference catalogs debugging tactics, anti-patterns, and common failure modes organized by language and framework. Use it when investigating unfamiliar errors or when the root cause is not immediately obvious.

## Table of Contents

- [Universal Patterns](#universal-patterns)
- [Python](#python)
- [JavaScript / TypeScript](#javascript--typescript)
- [Java](#java)
- [Go](#go)
- [Rust](#rust)
- [C / C++](#c--c)
- [Shell / Bash](#shell--bash)

---

## Universal Patterns

### Binary Search Debugging

When you do not know which change introduced a bug, use binary search on commits, configuration flags, or code blocks. Halve the search space each iteration.

- **Commits**: Use `git bisect` with an automated reproduction test. See `scripts/bisect-automation.sh`.
- **Code blocks**: Comment out half of a function or module to see if the bug persists.
- **Configuration**: Toggle feature flags in halves to isolate the offending setting.

### Rubber Ducking

Explain the code line-by-line to an inanimate object (or a patient colleague). The act of verbalizing assumptions often reveals hidden ones.

### Delta Debugging

Strip away code, inputs, or environment variables while preserving the failure. The smallest input that still triggers the bug is the minimal reproduction case.

### Change One Thing at a Time

Do not modify multiple variables simultaneously. If you change the code and the environment at the same time, you cannot attribute the result.

### Reversible Experiments

Before inserting log statements, temporary files, or environment overrides, ensure you can undo them cleanly. Use `git stash`, environment-specific overrides, or feature branches.

---

## Python

### Pattern: Trace Expression Evaluation

Use `ast` or `dis` to inspect what Python actually executes, not what you think it executes.

```python
import dis
def suspicious():
    return [] is []
dis.dis(suspicious)
```

### Pattern: Interactive Post-Mortem

When a script crashes, drop into the debugger at the exception site.

```python
import pdb, sys
sys.excepthook = lambda t, v, tb: pdb.post_mortem(tb)
```

### Pattern: Watch Mutable Defaults

Function default arguments are evaluated once at definition time, not at call time.

```python
def append_item(item, target=[]):  # DANGER: shared list
    target.append(item)
    return target
```

Fix: use `None` as the default and assign inside the function.

### Pattern: Trace Memory Growth

Use `tracemalloc` to find the line allocating the most memory.

```python
import tracemalloc
tracemalloc.start()
# ... run suspect code ...
current, peak = tracemalloc.get_traced_memory()
snapshot = tracemalloc.take_snapshot()
top_stats = snapshot.statistics('lineno')
for stat in top_stats[:10]:
    print(stat)
```

### Anti-Pattern: Catching Bare `except:`

`except:` catches `SystemExit`, `KeyboardInterrupt`, and `GeneratorExit`. Use `except Exception:` instead unless you truly intend to suppress all exits.

### Anti-Pattern: Implicit String Concatenation in Lists

```python
my_list = [
    "a",
    "b"  # Missing comma
    "c"
]
# Results in ["a", "bc"] rather than a syntax error.
```

---

## JavaScript / TypeScript

### Pattern: Async Stack Trace Preservation

Native Promise stacks can be shallow. Use `async/await` instead of `.then()` chains to preserve stack depth.

```javascript
// Harder to trace
fetch('/api').then(r => r.json()).then(data => parse(data));

// Better stack trace
const r = await fetch('/api');
const data = await r.json();
parse(data);
```

### Pattern: Runtime Type Guards

When TypeScript types are wrong at runtime (e.g., API drift), add defensive guards.

```typescript
function isUser(obj: unknown): obj is User {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'id' in obj &&
    typeof (obj as Record<string, unknown>).id === 'string'
  );
}
```

### Anti-Pattern: Loose Equality Pitfalls

```javascript
0 == '0'        // true
0 == []         // true
'' == false     // true
null == undefined // true
```

Always use `===` and `!==` unless you explicitly need coercion.

### Anti-Pattern: Unhandled Promise Rejections

Unhandled rejections do not always crash the process immediately. They can manifest as silent hangs.

```javascript
// BAD: no catch
fetch('/api');

// GOOD: always attach catch or await with try/catch
fetch('/api').catch(err => logger.error(err));
```

### Anti-Pattern: Mutating Props in React

React props are read-only. Mutating them breaks reactivity assumptions and causes stale UI.

```javascript
// WRONG
props.items.push(newItem);

// RIGHT
const nextItems = [...props.items, newItem];
```

---

## Java

### Pattern: Deadlock Detection

Use `jstack` or programmatic `ThreadMXBean` to detect deadlocks.

```java
ThreadMXBean bean = ManagementFactory.getThreadMXBean();
long[] deadlocked = bean.findDeadlockedThreads();
if (deadlocked != null) {
    ThreadInfo[] infos = bean.getThreadInfo(deadlocked);
    // log or alert
}
```

### Pattern: VM Flight Recorder

For performance or intermittent bugs, use JDK Flight Recorder (JFR) to capture events with minimal overhead.

```bash
jcmd <pid> JFR.start duration=60s filename=recording.jfr
```

### Anti-Pattern: Synchronizing on Mutable Fields

```java
private List<String> list = new ArrayList<>();

public void broken() {
    synchronized (list) {  // DANGER: if list is reassigned, locks split
        // ...
    }
}
```

Fix: synchronize on a private final `Object` lock, or use `Collections.synchronizedList` / `CopyOnWriteArrayList`.

### Anti-Pattern: `==` on Boxed Types

```java
Integer a = 128;
Integer b = 128;
a == b;  // false (outside the -128 to 127 cache)
```

Always use `.equals()` for boxed numeric comparisons.

### Anti-Pattern: `Stream` Resource Leaks

Streams implementing `Closeable` (e.g., `Files.lines`) must be closed.

```java
// LEAK
Files.lines(path).forEach(System.out::println);

// SAFE
try (Stream<String> lines = Files.lines(path)) {
    lines.forEach(System.out::println);
}
```

---

## Go

### Pattern: Goroutine Leak Detection

Goroutines blocked on channel sends/receives with no corresponding receiver/sender leak forever.

```go
// Leak: send with no receiver
go func() { ch <- 1 }()

// Fix: buffered channel or ensure receiver exists
ch := make(chan int, 1)
go func() { ch <- 1 }()
```

Use `runtime.NumGoroutine()` in tests to assert no leaks.

### Pattern: Context Timeout Root Cause

When a context deadline exceeds, check whether the timeout is too aggressive or if the downstream service is slow.

```go
ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
defer cancel()
resp, err := client.Get(ctx, req) // if err == context.DeadlineExceeded, investigate both sides
```

### Anti-Pattern: Loop Variable Capture in Goroutines

Same issue as JavaScript closures: the loop variable is reused across iterations.

```go
for _, v := range items {
    go func() {
        fmt.Println(v) // All goroutines print the last value
    }()
}

// Fix: pass v as a parameter
for _, v := range items {
    go func(v string) {
        fmt.Println(v)
    }(v)
}
```

---

## Rust

### Pattern: Compiler-Driven Debugging

Rust's borrow checker errors often point to the exact line where an ownership or lifetime assumption breaks. Read the full diagnostic; it suggests fixes.

### Pattern: `dbg!` Macro

Use `dbg!(expr)` for quick, ownership-preserving prints that include file and line info.

```rust
let x = dbg!(compute());
```

### Anti-Pattern: `unwrap()` in Production Paths

`unwrap()` panics on `None`/`Err`. Use `?` propagation or explicit `match` in any path that handles external input.

### Anti-Pattern: Iterator Invalidation

Rust prevents this at compile time, but if you use `unsafe` or interior mutability (e.g., `RefCell`), you can still trigger `borrow_mut` panics at runtime.

---

## C / C++

### Pattern: AddressSanitizer (ASan)

Compile with `-fsanitize=address` to catch use-after-free, buffer overflows, and leaks with minimal runtime overhead compared to Valgrind.

```bash
clang -fsanitize=address -g program.c -o program
./program
```

### Pattern: UndefinedBehaviorSanitizer (UBSan)

Compile with `-fsanitize=undefined` to catch signed overflow, misaligned pointers, and other undefined behavior.

### Anti-Pattern: Use After Move

In C++11 and later, using a moved-from object leaves it in a valid but unspecified state.

```cpp
std::vector<int> a = {1, 2, 3};
std::vector<int> b = std::move(a);
a.push_back(4);  // a is valid but contents are unspecified; dangerous pattern
```

### Anti-Pattern: Missing `virtual` Destructors

Deleting a derived class through a base pointer without a virtual destructor is undefined behavior.

```cpp
class Base { /* missing virtual ~Base() */ };
class Derived : public Base {};
Base* b = new Derived();
delete b;  // UB: Derived destructor never called
```

---

## Shell / Bash

### Pattern: Trace Execution

Use `set -x` to print each command before execution. Combine with `PS4` for richer context.

```bash
#!/bin/bash
set -euo pipefail
set -x
PS4='+ ${BASH_SOURCE}:${LINENO}:${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
```

### Pattern: Dry-Run Wrappers

Prefix destructive commands with a guard variable.

```bash
DRY_RUN=${DRY_RUN:-false}
run() {
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[dry-run] $*"
    else
        "$@"
    fi
}
run rm -rf /important/path
```

### Anti-Pattern: Unquoted Variables

Unquoted variables undergo word splitting and glob expansion.

```bash
file="my file.txt"
cat $file   # Tries to cat "my" and "file.txt"
cat "$file" # Correct
```

### Anti-Pattern: `set -e` with Subshell Pipes

`set -e` does not trigger on the left side of a pipe if the right side succeeds.

```bash
set -e
bad_command | cat  # bad_command failure is masked
grep something file | head -1  # grep failure is masked if head succeeds
```

Fix: use `set -o pipefail` (Bash 3.0+) to propagate pipe errors.

---

## Contributing

When you discover a new language-specific gotcha or debugging pattern, add it to the appropriate section with a short code example and a clear fix.
