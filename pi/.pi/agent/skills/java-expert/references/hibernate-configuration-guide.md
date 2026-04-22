# Hibernate Configuration Guide

## Basic Configuration (application.yml)

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb
    username: appuser
    password: ${DB_PASSWORD}
    driver-class-name: org.postgresql.Driver
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
      connection-timeout: 20000
      idle-timeout: 300000
      max-lifetime: 1200000

  jpa:
    hibernate:
      ddl-auto: validate
    properties:
      hibernate:
        dialect: org.hibernate.dialect.PostgreSQLDialect
        format_sql: true
        jdbc:
          batch_size: 50
        order_inserts: true
        order_updates: true
        generate_statistics: false
    show-sql: false
```

## DDL-Auto Strategies

| Value | Behavior | Recommended For |
|-------|----------|-----------------|
| `validate` | Validate schema against entities; fail on mismatch | Production |
| `update` | Update schema automatically | Development only |
| `create` | Drop and create on startup | Integration tests |
| `create-drop` | Drop on shutdown | Unit tests with H2 |
| `none` | Do nothing | When using Flyway/Liquibase |

**Recommendation:** Use `validate` in production and manage schema changes with Flyway or Liquibase.

## Fetch Strategies

### Eager vs Lazy
```java
@Entity
public class Order {
    @ManyToOne(fetch = FetchType.LAZY)  // Preferred
    private Customer customer;

    @OneToMany(mappedBy = "order", fetch = FetchType.LAZY)  // Preferred
    private List<OrderItem> items;
}
```

Always prefer `LAZY` fetching. `EAGER` fetching causes N+1 query problems and loads unnecessary data.

### Solving N+1 with Fetch Joins
```java
@Query("SELECT o FROM Order o JOIN FETCH o.customer JOIN FETCH o.items WHERE o.id = :id")
Optional<Order> findByIdWithDetails(@Param("id") Long id);
```

### Entity Graphs
```java
@NamedEntityGraph(
    name = "Order.withCustomerAndItems",
    attributeNodes = {
        @NamedAttributeNode("customer"),
        @NamedAttributeNode("items")
    }
)
@Entity
public class Order { ... }

// Usage
EntityGraph<?> graph = entityManager.getEntityGraph("Order.withCustomerAndItems");
Map<String, Object> hints = Map.of("jakarta.persistence.loadgraph", graph);
Order order = entityManager.find(Order.class, id, hints);
```

## Batching

Batching reduces the number of round-trips for insert/update operations.

```yaml
spring:
  jpa:
    properties:
      hibernate:
        jdbc:
          batch_size: 50
        order_inserts: true
        order_updates: true
```

For batch fetching of lazy associations:
```java
@BatchSize(size = 50)
@OneToMany(mappedBy = "order")
private List<OrderItem> items;
```

## Caching

### Second-Level Cache (EhCache / Caffeine)
```java
@Entity
@Cacheable
@Cache(usage = CacheConcurrencyStrategy.READ_WRITE)
public class Product { ... }
```

```yaml
spring:
  jpa:
    properties:
      hibernate:
        cache:
          use_second_level_cache: true
          region:
            factory_class: org.hibernate.cache.jcache.internal.JCacheRegionFactory
```

### Query Cache
```java
@QueryHints(@QueryHint(name = "org.hibernate.cacheable", value = "true"))
@Query("SELECT p FROM Product p WHERE p.category = :category")
List<Product> findByCategory(@Param("category") String category);
```

## Pagination

Always paginate list endpoints to avoid loading large result sets into memory.

```java
@GetMapping
public Page<ProductResponse> getProducts(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "20") int size,
        @RequestParam(defaultValue = "id,asc") String[] sort) {
    Sort.Direction direction = sort[1].equalsIgnoreCase("desc") ? Sort.Direction.DESC : Sort.Direction.ASC;
    Pageable pageable = PageRequest.of(page, size, Sort.by(direction, sort[0]));
    return productRepository.findAll(pageable).map(productMapper::toResponse);
}
```

## Connection Pool Tuning

HikariCP is the default in Spring Boot 3. Key settings:

- `maximum-pool-size`: Should be slightly less than the database's max connections. Rule of thumb: `(core_count * 2) + effective_spindle_count`.
- `connection-timeout`: How long to wait for a connection from the pool (default 30s).
- `idle-timeout`: How long a connection can sit idle before being retired.
- `max-lifetime`: Maximum lifetime of a connection in the pool (should be less than database wait_timeout).

## Logging and Debugging

Enable SQL logging in development:
```yaml
spring:
  jpa:
    show-sql: true
logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE
```

## Common Pitfalls

1. **Calling `save()` in a loop:** Use batching or `saveAll()`
2. **Unidirectional `@OneToMany` without `mappedBy`:** Creates a join table unexpectedly
3. **Forgetting `equals()` and `hashCode()` in `@Entity` classes:** Use the entity identifier, but only for detached objects
4. **Using `CascadeType.ALL` recklessly:** Can delete entire object graphs unintentionally
5. **Not handling `LazyInitializationException`:** Fetch data inside the transactional boundary or use DTO projections
