# Database migration rules

Use for Flyway, Liquibase, DDL changes, indexes, schema evolution, and zero-downtime
deployments.

## One schema authority

- Use the project's existing migration tool. Do not mix Flyway and Liquibase.
- Treat committed migrations as the production schema history.
- In production, prefer Hibernate schema validation over automatic schema mutation.
- Once a versioned migration has shipped to shared/prod environments, add a new
  migration instead of editing history.

## Safe change design

For services deployed independently of database changes, prefer expand/contract:

1. add compatible schema,
2. deploy code that can use old + new shape if necessary,
3. backfill safely,
4. switch reads/writes,
5. remove old schema in a later deployment.

Do not combine a breaking rename/drop and code switch into one deploy unless downtime
is explicitly acceptable.

## Constraints and backfills

- Add `NOT NULL` carefully on populated large tables: backfill first or use a
  database-specific online-safe strategy.
- Add defaults deliberately; defaults can lock/rewrite tables depending on database
  and version.
- Validate uniqueness before adding a unique constraint.
- Make backfills restartable/idempotent when they may run long.
- Keep data migrations bounded; do not hide millions-row Java loops in app startup.

## Indexes

- Create indexes for observed query patterns, foreign-key access, uniqueness, or known
  production needs.
- Do not add an index for every column.
- Account for write cost and storage.
- Use online/concurrent index creation where the database supports it and deployment
  requirements need it.
- Verify column order against predicates/sort order and inspect query plans.

## Naming and portability

- Preserve the repository's naming convention.
- Use database-specific SQL when it materially improves correctness/operations, but
  document/test that dependency.
- Keep rollback expectations realistic. Destructive data migrations often cannot be
  truly rolled back; forward-fix may be safer.

## Tests

- Run migrations from an empty database in CI/integration tests.
- Test upgrade paths for important releases when old production schemas matter.
- Prefer Testcontainers/real database semantics for migration tests.
- Ensure JPA validation succeeds against the migrated schema.

## Check

Confirm behavior on non-empty data, rollout compatibility, lock/rewrite risk, and
agreement between the migration and application mappings.
