# Performance and JVM rules

Use for slow endpoints, high CPU, memory/GC pressure, startup cost, caching, and
performance-sensitive refactors.

## Measure first

Before changing code, identify the bottleneck with evidence:

- endpoint/application metrics,
- SQL/query count and query plans,
- Java Flight Recorder,
- async-profiler or equivalent profiler,
- heap dump/allocation profile for memory issues,
- GC logs only when GC behavior is actually implicated.

Do not optimize code because a pattern merely "looks slow".

## High-value application checks

- N+1 queries and over-fetching usually matter more than stream micro-optimizations.
- Bound request/result sizes.
- Avoid repeated serialization/deserialization of the same large objects.
- Avoid remote fan-out without concurrency/downstream limits.
- Keep transactions and DB connections shorter than necessary.
- Use batching for bulk writes when supported and measured.
- Use projections for read paths that need a small subset of entity state.

## Caching

- Add caching only when repeated computation/I/O is expensive enough to justify
  staleness and invalidation complexity.
- Define key, TTL/expiry, maximum size, and invalidation behavior.
- Never use an unbounded in-memory cache for user-controlled keys.
- Cache the narrowest stable representation.
- Treat distributed cache failure as an explicit behavior choice.
- Prevent cache stampedes on expensive hot keys when relevant.

## Pools

- Size database connection pools for database capacity/latency, not for HTTP thread
  count.
- Virtual threads do not mean "increase every pool".
- Do not add generic executor pools without queue, saturation, and rejection semantics.
- Monitor pool saturation before tuning.

## JVM

- Start with supported JVM defaults. Do not add random `-XX` flags from old tuning
  guides.
- G1 is a strong general default; evaluate ZGC when low-pause requirements and heap
  size justify it.
- Tune heap/GC from real pause, allocation, and container-memory evidence.
- Use JMH for microbenchmarks. Do not benchmark hot code with one `System.nanoTime`
  loop.
- Treat native image/AOT as a startup/memory/deployment tradeoff, not a free
  performance upgrade.

## Allocation and Java code

Only after profiling:

- remove avoidable boxing/allocation in genuine hot paths,
- use primitive streams/arrays when they demonstrably help,
- avoid regex/repeated format construction in tight loops,
- keep hot data structures simple and local.

Readability wins outside measured hot paths.

## Check

Confirm the measured bottleneck, cache bounds and invalidation, scarce-resource pool
limits, and evidence for every JVM or code-level optimization.
