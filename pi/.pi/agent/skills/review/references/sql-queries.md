# SQL Queries Review Checklist

Use this reference when reviewing SQL (or ORM-generated) queries in any backend application.

## Correctness
- [ ] Queries return the expected columns and rows for the business requirement.
- [ ] Joins use the correct join type (INNER, LEFT, etc.) and conditions.
- [ ] Aggregate queries handle NULLs and empty result sets appropriately.
- [ ] Date/time comparisons account for time zones if applicable.

## Security
- [ ] All user input is parameterized; no string concatenation into query text.
- [ ] Dynamic table/column names are validated against a whitelist if unavoidable.
- [ ] ORM query builders (e.g., JPA Criteria, SQLAlchemy) are not bypassed with raw SQL without justification.

## Performance
- [ ] Indexes exist for columns used in WHERE, JOIN, and ORDER BY clauses.
- [ ] SELECT * is avoided when only specific columns are needed.
- [ ] N+1 query patterns are eliminated via JOIN FETCH, eager loading, or batching.
- [ ] Large result sets use pagination (LIMIT/OFFSET or keyset pagination).
- [ ] Expensive operations (sorting, filtering) are not performed on the client if the database can do them efficiently.

## Transactions
- [ ] Database transactions wrap multi-step write operations.
- [ ] Transaction boundaries are appropriate: not too short (leaving partial state) nor too long (holding locks).
- [ ] Isolation level is chosen consciously; default READ COMMITTED may not suffice for concurrent updates.

## Migrations
- [ ] Schema changes include rollback steps where possible.
- [ ] Migrations do not lock tables for extended periods on large datasets.
