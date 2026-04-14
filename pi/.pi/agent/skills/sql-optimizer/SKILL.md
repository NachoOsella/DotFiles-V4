---
name: sql-optimizer
description: "Optimize SQL queries and database schemas for performance. Use when you need to: (1) analyze slow queries, (2) add or optimize indexes, (3) review database schemas, (4) interpret EXPLAIN plans, (5) fix N+1 query problems, or (6) design efficient data models."
---

# SQL Optimization

## Query Analysis

### EXPLAIN Plan
```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'test@example.com';
```

Key indicators:
- **Seq Scan**: Full table scan (often bad)
- **Index Scan**: Using an index (good)
- **Nested Loop**: Watch for N+1 issues
- **Hash Join**: Efficient for large datasets

## Common Optimizations

### Add Missing Indexes
```sql
-- For frequent WHERE clauses
CREATE INDEX idx_users_email ON users(email);

-- For composite queries
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at);
```

### Avoid SELECT *
```sql
-- Bad
SELECT * FROM users WHERE id = 1;

-- Good
SELECT id, name, email FROM users WHERE id = 1;
```

### Fix N+1 Queries
```sql
-- Instead of querying in a loop, use JOIN
SELECT u.*, o.* 
FROM users u 
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.id IN (1, 2, 3);
```

### Use LIMIT for Pagination
```sql
SELECT * FROM orders 
ORDER BY created_at DESC 
LIMIT 20 OFFSET 40;
```

## Schema Design

- Normalize to reduce redundancy (3NF)
- Denormalize strategically for read performance
- Use appropriate data types (smallest that fits)
- Consider partitioning for large tables

## Database-Specific Notes

Consider the specific engine (PostgreSQL, MySQL, SQLite) when optimizing:
- PostgreSQL: VACUUM, partial indexes
- MySQL: Query cache, InnoDB buffer pool
- SQLite: WAL mode for concurrency
