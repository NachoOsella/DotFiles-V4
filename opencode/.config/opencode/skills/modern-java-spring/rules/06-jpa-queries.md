# JPA query and fetching rules

Use for Spring Data repositories, JPQL, Criteria/Specifications, projections, fetch
plans, pagination, and N+1 problems.

## Repository methods

- Prefer clear derived query methods while the name remains readable.
- When a derived method becomes a sentence, use an explicit `@Query`, Specification,
  Querydsl/jOOQ if already present, or a custom repository implementation.
- Do not create repository methods that return far more state than the caller needs.
- Use DTO/class projections, interface projections, or explicit select clauses for
  read-heavy views.
- Records are a good fit for class-based DTO projections when constructor mapping
  matches.
- Avoid `Optional<List<T>>`; return an empty collection.

## Fetch plans

- Treat N+1 as a query/fetch-plan problem, not an entity-mapping excuse.
- Keep associations lazy by default, then fetch what the use case needs with:
  - `join fetch` for suitable single-query graphs,
  - `@EntityGraph` for repository-level fetch plans,
  - projections for read models,
  - batch fetching when repeated lazy loads are intentional.
- Do not globally mark associations EAGER to remove N+1.
- Avoid fetching multiple large to-many collections in one cartesian-product query.
- Inspect generated SQL for non-trivial collection graphs.

## Pagination and large result sets

- Page with a stable deterministic sort.
- Do not combine collection fetch joins with ordinary root pagination unless the
  detected Hibernate and database combination is proven to apply limits safely. On
  combinations that may paginate in memory, consider
  `hibernate.query.fail_on_pagination_over_collection_fetch=true` to fail explicitly.
- For a paged aggregate with children, consider:
  1. page IDs/root rows,
  2. fetch the required graph for those IDs.
- Use projections when the page only needs a subset of columns.
- Consider keyset/seek pagination for large/deep page traversal.
- Stream/scroll large datasets only with a clear transaction/resource lifecycle.

## Query safety

- Parameterize values. Never build JPQL/HQL/native SQL by concatenating untrusted
  strings.
- Allowlist dynamic identifiers such as sort fields; bind parameters cannot protect
  identifiers.
- Prefer JPQL/Criteria for portable domain queries and native SQL when database-specific
  features or performance justify it.
- Keep native queries covered by integration tests against the real database.

## Modifying and bulk queries

- Use `@Modifying` deliberately.
- Remember bulk JPQL/SQL updates bypass managed entity state and callbacks. They
  normally do not apply per-entity optimistic locking; include an expected-version
  predicate or use entity updates when stale-write detection is required.
- Flush/clear or isolate the persistence context when stale managed entities could
  survive a bulk operation. For large entity-based batches, flush and clear in bounded
  chunks so the persistence context does not grow without limit.
- Do not use per-row entity loops for a true bulk operation without considering a
  set-based update.
- Conversely, do not use bulk SQL when entity callbacks/invariants must execute.

## Query count and plans

When performance matters:

- reproduce the endpoint/use case,
- inspect query count and SQL,
- inspect the database query plan for slow SQL,
- then change fetch/query/index strategy.

Do not "optimize" repository code from aesthetics alone.

## Check

Confirm query count, fetch-plan and pagination compatibility, parameterization, and
persistence-context behavior for bulk work.
