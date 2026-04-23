---
name: sql-optimizer
description: Use for optimizing SQL queries, indexes, and schemas.
---

# SQL Optimization

## Step-by-Step Workflow: Analyzing a Slow Query

1. **Reproduce the slowness**
   - Run the query with timing: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ...` (PostgreSQL) or `EXPLAIN ANALYZE ...` (MySQL/SQLite).
   - Note total execution time and row counts.

2. **Read the execution plan bottom-up**
   - Start from the innermost nodes (the actual data access).
   - Look for red flags: Seq Scan, high-loop Nested Loop, Sorts on large sets, high buffer counts.

3. **Identify the biggest cost driver**
   - In PostgreSQL: check `actual_total_time` per node.
   - In MySQL: check the `rows` and `filtered` columns.
   - Focus on the node consuming the most time, not necessarily the first one.

4. **Check for missing indexes**
   - Are WHERE, JOIN, or ORDER BY columns unindexed?
   - Are index scans actually doing bitmap index scans or index-only scans?
   - Run the missing-index diagnostic queries in `scripts/missing_index_suggester.sql` for your engine.

5. **Verify statistics are fresh**
   - PostgreSQL: `ANALYZE table_name;`
   - MySQL: `ANALYZE TABLE table_name;`
   - SQLite: `ANALYZE;`

6. **Apply the smallest fix first**
   - Add a targeted index.
   - Rewrite the query to avoid `SELECT *`, unnecessary sorting, or subqueries.
   - Update statistics and re-run `EXPLAIN ANALYZE`.

7. **Validate improvement**
   - Compare before/after execution time and buffer counts.
   - Ensure the fix does not regress other workloads (check query caches, lock contention).

---

## Query Analysis

### EXPLAIN Plan Basics
```sql
-- PostgreSQL
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM users WHERE email = 'test@example.com';

-- MySQL
EXPLAIN ANALYZE
SELECT * FROM users WHERE email = 'test@example.com';

-- SQLite
EXPLAIN QUERY PLAN
SELECT * FROM users WHERE email = 'test@example.com';
```

Key indicators:
- **Seq Scan**: Full table scan (often bad on large tables)
- **Index Scan / Index Only Scan**: Using an index (good)
- **Bitmap Index Scan**: PostgreSQL-specific; good for moderate selectivity
- **Nested Loop**: Watch for N+1 issues; expensive when outer rows are high
- **Hash Join**: Efficient for large, unsorted datasets
- **Merge Join**: Efficient when inputs are sorted

### Automated Plan Analysis
Use the script in `scripts/explain_analyzer.py` to automatically flag common problems in EXPLAIN output.

---

## Scripts

### `scripts/explain_analyzer.py`
Parses EXPLAIN (ANALYZE, FORMAT JSON) output and highlights performance problems such as sequential scans, expensive nested loops, and high buffer usage.

Usage:
```bash
python scripts/explain_analyzer.py plan.json
```

Flags:
- `Seq Scan` on tables > 10,000 estimated rows
- `Nested Loop` with actual loops > 1,000
- `Sort` operations without an index
- High shared buffer reads (> 10,000 buffers)

### `scripts/missing_index_suggester.sql`
Engine-specific diagnostic queries to suggest missing indexes based on frequent queries and table access patterns.

- **PostgreSQL**: Uses `pg_stat_statements` + `pg_stat_user_tables` to find sequential scans and frequent queries.
- **MySQL**: Uses `performance_schema.table_io_waits_summary_by_table` and `sys.schema_index_statistics`.
- **SQLite**: Queries `sqlite_master` and uses `EXPLAIN QUERY PLAN` heuristics.

See the script comments for per-engine instructions.

---

## Common Optimizations

### Add Missing Indexes
```sql
-- Single-column for frequent WHERE clauses
CREATE INDEX idx_users_email ON users(email);

-- Composite index: column order matters (left-to-right prefix usage)
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at);

-- Partial index for filtered subsets (PostgreSQL)
CREATE INDEX idx_orders_unshipped ON orders(created_at) WHERE shipped = false;

-- Covering index (MySQL / PostgreSQL index-only scans)
CREATE INDEX idx_orders_covering ON orders(user_id, status, created_at);
```

### Avoid SELECT *
```sql
-- Bad: pulls unnecessary columns, breaks index-only scans,
-- and can explode memory when joined with wide tables
SELECT * FROM users u
JOIN orders o ON u.id = o.user_id;

-- Good: fetch only needed columns
SELECT u.id, u.name, o.id, o.total
FROM users u
JOIN orders o ON u.id = o.user_id;
```

### Fix N+1 Queries
```sql
-- Instead of querying in a loop, use JOIN or IN
SELECT u.id, u.name, o.id AS order_id
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.id IN (1, 2, 3);
```

### Use LIMIT for Pagination
```sql
-- Basic pagination
SELECT id, name
FROM orders
ORDER BY created_at DESC
LIMIT 20 OFFSET 40;

-- Better for deep pagination (keyset / cursor pagination)
SELECT id, name
FROM orders
WHERE created_at < '2024-01-01'
ORDER BY created_at DESC
LIMIT 20;
```

### Update Statistics
```sql
-- PostgreSQL
ANALYZE users;

-- MySQL
ANALYZE TABLE users;

-- SQLite
ANALYZE;
```

---

## Schema Design

- Normalize to reduce redundancy (3NF)
- Denormalize strategically for read performance (e.g., materialized views, summary tables)
- Use appropriate data types (smallest that fits; prefer `TIMESTAMP` over `VARCHAR` for dates)
- Consider partitioning for large tables (PostgreSQL/MySQL)
- Avoid nullable columns in frequently queried composite indexes when possible

---

## Gotchas

1. **Low-cardinality indexes rarely help**
   - An index on `gender` or `boolean` columns usually does not improve performance because the selectivity is too low. The optimizer will often ignore it and fall back to a sequential scan.

2. **Multi-column indexes only work left-to-right**
   - `CREATE INDEX idx ON table(a, b, c)` can satisfy queries on `a`, `a + b`, or `a + b + c`, but not `b` or `c` alone. Put the most selective, most frequently filtered column first.

3. **SELECT * with JOINs can explode the result buffer**
   - Joining two wide tables with `SELECT *` multiplies the row width, increases network I/O, memory usage, and sort temp space. It also prevents index-only scans because the query planner must fetch heap tuples for every column.

4. **More indexes are not always better**
   - Every `INSERT`, `UPDATE`, and `DELETE` must maintain each index. Write-heavy tables with many indexes suffer from lock contention and slower writes.

5. **Functions on indexed columns prevent index usage**
   - `WHERE LOWER(email) = 'test@example.com'` cannot use a plain `email` index. Use a functional index (PostgreSQL) or generated column + index (MySQL 8+).

6. **Implicit type casting can defeat indexes**
   - Comparing a `VARCHAR` indexed column to a number (e.g., `WHERE phone = 12345`) can cause implicit casts that bypass the index. Ensure parameter types match column types.

---

## References

### PostgreSQL
- **VACUUM / AUTOVACUUM**: Reclaims dead tuples and updates visibility maps. Run `VACUUM ANALYZE` after large deletes/updates. Monitor with `pg_stat_user_tables`.
- **Partial Indexes**: Index only a subset of rows to reduce size and improve write performance.
  ```sql
  CREATE INDEX idx ON events(created_at) WHERE type = 'error';
  ```
- **JSONB**: Use GIN indexes for fast containment and key-exists queries.
  ```sql
  CREATE INDEX idx ON logs USING GIN (data jsonb_path_ops);
  ```
- **Index-Only Scans**: Require a covering index and up-to-date visibility maps (maintained by VACUUM).
- **Partitioning**: Native declarative partitioning since PG 10; use for time-series or very large tables.

### MySQL
- **Covering Indexes**: When all selected columns are in the index, InnoDB can avoid the primary-key lookup (index-only scan).
- **Query Cache**: Removed in MySQL 8.0. For 5.7 and earlier, it often hurt write-heavy workloads. Prefer application-level caching.
- **InnoDB Buffer Pool**: Size it to ~70-80% of RAM on dedicated DB servers. Monitor hit ratio via `SHOW ENGINE INNODB STATUS`.
- **Optimizer Hints**: Use sparingly; prefer `ANALYZE TABLE` to fix bad plans caused by stale statistics.
- **Generated Columns + Indexes**: Index expressions without rewriting queries.
  ```sql
  ALTER TABLE users ADD COLUMN email_lower VARCHAR(255) AS (LOWER(email)) STORED;
  CREATE INDEX idx ON users(email_lower);
  ```

### SQLite
- **WAL Mode**: Enables better concurrency for reads and writes.
  ```sql
  PRAGMA journal_mode = WAL;
  ```
- **FTS5 / FTS3**: For full-text search, use virtual FTS tables instead of `LIKE '%term%'` queries.
  ```sql
  CREATE VIRTUAL TABLE docs USING fts5(title, content);
  ```
- **Indexes on Expressions**: SQLite 3.9+ supports indexing expressions.
  ```sql
  CREATE INDEX idx ON users(LOWER(email));
  ```
- **ANALYZE**: SQLite uses a cost-based optimizer; running `ANALYZE` is critical for good plans.
- **LIMIT without ORDER BY** is non-deterministic; always pair them.
