# JPA and Hibernate entity rules

Use when creating or changing entities, associations, value objects, cascading, or
entity identity.

## Entity shape

- Use ordinary classes for entities, not records.
- Provide a JPA-compatible no-arg constructor, normally `protected`.
- Keep setters limited. Prefer constructors/factories for required state and domain
  methods for meaningful transitions.
- Do not use Lombok `@Data` on entities.
- Avoid `@Builder` if it lets callers bypass required state or bidirectional-link
  maintenance.
- Use `@Enumerated(EnumType.STRING)` for enums unless a deliberate converter/database
  representation exists.
- Prefer `Instant`, `LocalDate`, `BigDecimal`, and value converters/embeddables over
  lossy primitive/string representations.
- Initialize collection associations (`new ArrayList<>()`, `new HashSet<>()`) to avoid
  null collection state.

- Choose ID generation deliberately for the database and workload. Do not assume
  `GenerationType.AUTO` keeps the same physical strategy across Hibernate or dialect
  upgrades. Preserve existing schema semantics during maintenance work.
- When insert batching matters, remember that `IDENTITY` requires immediate inserts and
  prevents JDBC insert batching in Hibernate 6/7. Prefer a sequence with an intentional
  allocation size where the database and existing schema support it.

## Associations

- Make fetch strategy explicit. Prefer LAZY associations by default, including to-one
  associations where supported.
- Do not switch mappings to EAGER to fix `LazyInitializationException` or N+1. Choose a
  fetch plan in the query/use case.
- Model cascade operations narrowly. Do not use `CascadeType.ALL` by reflex.
- Use `orphanRemoval = true` only when the child lifecycle is truly owned by the parent.
- Maintain both sides of bidirectional associations through helper/domain methods.
- Avoid huge bidirectional graphs when a unidirectional association or foreign-key ID
  is enough.

## Identity and equality

- Never generate entity `equals`/`hashCode` mechanically with all fields.
- Exclude associations and mutable business fields from equality.
- If a stable immutable natural key exists, it can define equality.
- If equality is based on a generated database ID, handle the transient `null` ID case
  deliberately and keep hash behavior stable for objects stored in sets/maps.
- If the application does not need custom entity value equality, do not override it
  merely for style.
- Be aware of Hibernate proxies when using class checks in equality.

## Constraints and locking

- Reflect important database constraints in mapping (`nullable`, unique constraints,
  lengths) but keep the migration as the schema source of truth.
- Enforce uniqueness with a database constraint. A pre-check can improve the error
  message but cannot replace the constraint because concurrent requests can pass it.
- Use `@Version` for aggregates that need optimistic concurrency protection.
- Handle optimistic locking conflicts as a business/API conflict rather than blindly
  retrying every write.
- Rely on Hibernate dirty checking for managed entities inside a transaction. Do not
  call `save()` after every field/domain-method mutation just to force an update.
  Repository `save()` still has a role for new or deliberately merged entity state.
- Explicit table/column naming is optional if the project has a stable naming strategy;
  preserve local convention.

## Entities vs API/domain contracts

- Do not serialize entities directly from controllers.
- Do not accept entities as request bodies.
- Use DTOs/projections for external contracts and read models.
- Keep lazy associations out of `toString`, logging, and generated Lombok methods.

## Production defaults

For REST/service applications, prefer:

```properties
spring.jpa.open-in-view=false
spring.jpa.hibernate.ddl-auto=validate
```

Preserve intentional alternatives, but do not rely on Open Session in View to hide
fetch-plan problems, and do not let Hibernate mutate production schemas.

## Check

Confirm that identity, equality, association lifecycle, fetch defaults, and database
constraints remain coherent under transient, managed, and concurrent use.
