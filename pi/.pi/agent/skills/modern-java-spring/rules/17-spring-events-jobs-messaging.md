# Spring events, jobs, and messaging rules

Use for application events, transactional events, scheduling, durable jobs, Kafka, and
other message brokers.

## Application events

- Use events for meaningful decoupling or module notification, not to hide a direct
  method call.
- Keep payloads small, immutable, and explicit; records are a good fit.
- Name events in past tense when they represent something that happened, not commands
  disguised as events.
- Ordinary Spring application events are in-process and non-durable.
- Use `@TransactionalEventListener` when handling must relate to a commit phase. It still
  does not provide durable delivery, and database work after commit needs its own
  transaction.
- For reliable external publication with database state, use an outbox or another
  explicit consistency mechanism.

## Scheduling and jobs

- Scheduled work must be idempotent or protected against duplicate execution when
  multiple instances can run it.
- Define time zones explicitly for human-calendar schedules.
- Avoid long blocking work on a limited scheduler thread when it can delay later runs.
- Add a distributed lock or leader strategy only when duplicate execution is unsafe and
  multiple instances actually exist.
- Record job progress and outcomes so failure and partial completion are diagnosable.
- In-process scheduling is not durable job infrastructure. Use a durable job or message
  system when work must survive process restarts.

## Messaging

When a broker is already used or required:

- Define message contracts separately from JPA entities.
- Include stable message/event IDs when deduplication or idempotency matters.
- Assume duplicate delivery unless the configured system proves stronger semantics. Make
  side-effecting consumers idempotent where duplicates are possible.
- Configure bounded retries and dead-letter behavior deliberately. Do not retry poison
  messages forever.
- Evolve serialization schemas according to the compatibility required by existing
  producers and consumers.
- Do not hold a database transaction open while waiting on arbitrary broker/network
  work unless a supported coordinated pattern is deliberately used.
- Treat broker acknowledgement and database commit as separate failure boundaries unless
  an explicit consistency mechanism connects them.

## Failure and observability

- Fire-and-forget work needs explicit failure handling and operational visibility.
- Carry correlation and stable message identifiers without putting sensitive or
  high-cardinality data into metric tags.
- Define what happens after retries are exhausted and how operators can replay or repair
  failed work safely.

## Check

Confirm durability, duplicate-delivery behavior, transaction boundaries, retry limits,
and recovery for every event, job, or message path.
