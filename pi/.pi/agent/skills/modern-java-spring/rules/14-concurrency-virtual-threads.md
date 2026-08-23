# Concurrency and virtual-thread rules

Use for virtual threads, executors, `@Async`, shared mutable state, locks, and parallel
work.

## First classify the workload

- Blocking I/O concurrency: virtual threads can be a strong fit on Java 21+.
- CPU-bound parallel work: use bounded parallelism near the number of available cores.
- Reactive pipelines: stay reactive; do not mix blocking calls unless the stack
  explicitly isolates them.
- Sequential work: do not add concurrency without a latency/throughput reason.

## Virtual threads

- Virtual threads are final in Java 21.
- Use thread-per-task semantics for many blocking operations; do not create a pool of
  virtual threads just to cap thread count.
- Bound scarce resources separately: DB connections, downstream concurrency, file
  handles, rate-limited APIs.
- Enabling virtual threads does not increase the database connection pool and should
  not trigger a giant Hikari pool.
- For Spring Boot, use the supported virtual-thread configuration only after checking
  the detected Boot/JDK line and workload.
- Java 21-23 can pin carrier threads when blocking inside certain `synchronized`
  regions. JDK 24 removes monitor-induced pinning, including most `synchronized` cases;
  native and Foreign Function and Memory callbacks can still pin. Use JFR rather than
  guessing and do not ban `synchronized` globally.
- Virtual threads are daemon threads. Applications whose continued execution depends on
  scheduled/background virtual threads may need the Boot-supported keep-alive setting
  after verifying the detected version.
- Avoid massive per-thread `ThreadLocal` state. Verify framework context propagation
  when moving work across custom executors.

## Shared state

- Prefer immutability and confinement.
- Use `java.util.concurrent` primitives/collections instead of hand-rolled
  synchronization.
- `volatile` gives visibility/order, not atomic compound updates.
- Use atomics/locks for read-modify-write operations.
- Hold locks for the smallest correct region and unlock in `finally`.
- Establish a consistent lock order if multiple locks can be held.

## Executors and futures

- Do not create raw threads for application task management unless lifecycle is
  explicit.
- Own and close custom executors.
- `CompletableFuture` needs intentional executor choice, timeout/cancellation, and
  exception handling.
- Avoid the common fork-join pool for application-critical blocking tasks.
- Do not scatter `CompletableFuture.supplyAsync` to make synchronous code "modern".

## Spring `@Async`

- Use `@Async` for a real asynchronous boundary, not to hide latency.
- Remember proxy/self-invocation behavior.
- Define exception handling for fire-and-forget work.
- Prefer returning a result/future when callers need failure visibility.
- Do not assume async work participates in the caller's transaction.

## Cancellation and deadlines

- Carry request/job deadlines to downstream calls when possible.
- Handle interruption correctly and restore the interrupt flag when needed.
- Make long loops/tasks cancellation-aware if the application can abort them.

## Check

Confirm workload classification, scarce-resource bounds, context propagation, lifecycle,
cancellation, and exact JDK behavior before adding concurrency.
