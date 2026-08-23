# DTO, MapStruct, and Jackson rules

Use for request/response models, entity-domain mapping, MapStruct, and JSON contracts.

## DTOs

- Prefer records for immutable request/response DTOs, commands, events, and simple
  projections.
- Keep HTTP DTOs separate from JPA entities.
- Name transport types by role when useful: `CreateOrderRequest`, `OrderResponse`,
  `UpdateCustomerRequest`.
- Do not create one DTO per layer if all copies have identical semantics and no
  boundary benefit. Separate types where contracts, mutability, ownership, or exposure
  differ.
- Keep secrets/internal fields out of response types by construction rather than
  relying only on `@JsonIgnore`.

## Mapping strategy

Use manual mapping when:

- the mapping is small and obvious,
- custom logic dominates,
- adding a mapper framework would be more code than the mapping.

Use MapStruct when:

- many fields/types must stay aligned,
- nested mappings repeat,
- compile-time unmapped-field detection is valuable.

For MapStruct:

- use the Spring component model when mappers are injected,
- prefer constructor injection for mapper dependencies,
- centralize shared mapper config when several mappers use the same policies,
- consider `unmappedTargetPolicy = ERROR` for intentional API/domain mappings,
- explicitly ignore generated IDs, audit fields, and server-owned fields on
  request-to-entity mappings,
- do not hide business rules inside generated mapper expressions.

## Entity updates

- Do not reconstruct a managed entity from a request DTO if it destroys identity,
  associations, audit state, or optimistic-lock version.
- Load the aggregate, then apply allowed changes through methods or a deliberate update
  mapper.
- For PATCH-like updates, define absent vs explicit-null semantics. Do not let generic
  mapping accidentally erase fields.

## Jackson

- Preserve the repository's mapper configuration and detected Jackson major version.
  Spring Boot 4 uses Jackson 3 with `tools.jackson` packages; do not mix Jackson 2 and 3
  imports or configuration APIs during a focused change.
- Prefer explicit DTOs over enabling broad polymorphic deserialization.
- Never enable unsafe default polymorphic typing for untrusted JSON.
- Keep date/time formats and property names stable once they are public API contracts.
- Use `Instant`/ISO-8601 for machine timestamps unless the contract specifies another
  representation.
- Avoid returning arbitrary `Map<String, Object>` JSON for stable APIs.
- Be careful with bidirectional entity graphs. Better: do not serialize entities.

## Compatibility

- Treat renaming/removing JSON properties as an API change.
- Add aliases/custom handling only when migration compatibility is required, and remove
  temporary compatibility code deliberately later.
- For enum JSON values, consider whether Java enum constant renames would break clients;
  use an explicit external value when the contract must remain stable.

## Check

Confirm that clients cannot set server-owned fields and that mapping and Jackson APIs
match the detected project version.
