# Transaction rules

Use for `@Transactional`, unit-of-work design, propagation, isolation, locking, and
database consistency.

## Boundary

- Put transaction boundaries around application use cases that must be atomic.
- Prefer `@Transactional` on service/application methods, not controllers.
- Keep transaction scope as short as correctness allows.
- Repository CRUD methods may already be transactional, but a multi-step use case needs
  one outer transaction to define consistency.
- Mark read-only use cases `@Transactional(readOnly = true)` when the repository/provider
  benefits and the project uses this convention. Treat it as a hint, not a security
  boundary.

## Calls and proxies

- Remember proxy-based transaction advice may not apply to self-invocation.
- Do not put `@Transactional` on private helper methods and assume it creates a
  transaction.
- Check whether the bean/proxy style allows annotation interception.
- Prefer one clear public transactional entry point over annotation scattering.

## Propagation

- Use default `REQUIRED` unless semantics demand otherwise.
- Use `REQUIRES_NEW` only for a deliberately independent commit boundary; it can break
  atomicity and consume extra connections.
- Avoid `NESTED` unless the database/provider and business semantics truly need
  savepoints.
- Do not use propagation modes to paper over unclear ownership.

## Remote calls and side effects

- Avoid slow remote HTTP calls while holding a database transaction/connection when the
  workflow can be split safely.
- If database state and a message/event must be delivered reliably, consider an outbox
  or another explicit reliability pattern rather than "DB commit then hope publish
  works".
- For post-commit in-process work, transactional events may fit, but do not assume they
  provide durable delivery. Work that writes after commit needs its own transaction;
  resources left bound to the completed transaction do not create a second commit.

## Isolation and locking

- Keep the database default isolation unless a demonstrated anomaly requires a change.
- Use optimistic locking (`@Version`) when concurrent edits are expected and conflicts
  can be retried/resolved by the caller.
- Use pessimistic locking only when the invariant truly requires serialized access and
  contention is understood.
- Do not blindly retry all transaction failures. Retry only transient, safe-to-repeat
  operations with a bound/backoff.

## Exceptions and rollback

- Spring normally rolls back unchecked exceptions. If checked exceptions are used for
  domain failures, verify rollback semantics rather than assuming.
- Do not catch an exception inside a transaction and continue if the persistence
  context/transaction is already invalid.
- Translate persistence failures at the appropriate boundary while preserving the
  cause.

## Check

Confirm the protected invariant, interception path, rollback behavior, and that the
transaction spans the complete unit of work but no avoidable network latency.
