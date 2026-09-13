# Testing rules

Use for JUnit, Mockito, AssertJ, Spring test slices, integration tests, and
Testcontainers.

## Test the cheapest layer that proves the behavior

- Pure domain/application logic: plain JUnit, no Spring context.
- Collaborator isolation: Mockito when a real collaborator would make the test slow,
  nondeterministic, or cross a boundary.
- MVC serialization/routing/validation: `@WebMvcTest`.
- JPA mappings/queries: `@DataJpaTest` plus the real database when database semantics
  matter.
- REST clients: the framework's focused REST-client test support or a local stub server.
- Full wiring/smoke path: a small number of `@SpringBootTest` tests.
- End-to-end server behavior: real port only when container/server semantics matter.

Do not use `@SpringBootTest` for every test.

## Assertions and structure

- Prefer behavior-focused names that explain the scenario and expected outcome.
- Arrange/Act/Assert or Given/When/Then is useful when it improves scanning; do not
  force comments for obvious tests.
- Assert important outputs and side effects, not implementation call counts by default.
- Use AssertJ for expressive object/collection/exception assertions when available.
- Use parameterized tests for meaningful input matrices.
- Test boundaries, invalid values, empty cases, and concurrency/conflict behavior when
  relevant.

## Mockito

- Mock true architectural boundaries or costly/nondeterministic collaborators, not a
  type merely because it is an interface. Do not mock value objects.
- Avoid deep stubs and broad partial mocks.
- Do not mock JPA `EntityManager` behavior to prove a query works.
- Verify interactions only when the interaction itself is part of the contract.
- Prefer real simple collaborators over mocks when setup is cheaper.
- For Spring context bean overrides, use `@MockitoBean` on Spring Framework 6.2+ /
  Spring Boot 3.4+. Retain `@MockBean` on Boot 3.3 and earlier, or when preserving an
  existing convention outside a migration.

## Testcontainers

- Use Testcontainers for Postgres/MySQL/etc. integration when production database
  behavior matters.
- Do not use H2 as a fake Postgres/MySQL compatibility test unless the application is
  intentionally database-agnostic and that tradeoff is accepted.
- Reuse a container across tests/context where practical rather than starting one per
  test method.
- Use Spring Boot `@ServiceConnection` when supported by the detected version and it
  simplifies wiring.
- Run real migrations against the container when schema compatibility is in scope.

## Determinism

- Inject/control `Clock` for time-sensitive rules.
- Control random/UUID generation when exact outcomes matter.
- Do not use sleeps as synchronization. Await a condition with a bounded timeout.
- Avoid tests depending on execution order or shared mutable state.
- Clean database state explicitly or use transactional rollback where semantics match.
  Rollback-based tests do not prove post-commit events, real commit constraints, or
  cross-transaction locking; use explicit cleanup when those behaviors matter.

## Security behavior

- Security changes need tests for anonymous, authenticated-but-forbidden, and allowed
  requests, plus ownership or tenant isolation where applicable.
- Test CSRF according to the actual authentication model. For JWT tests, exercise claim
  and authority mapping rather than only bypassing the filter chain.

## What not to chase

- Coverage percentage is not the goal. Cover important behavior, boundaries, and
  failure paths.
- Do not unit-test trivial getters/generated code.
- Do not snapshot huge JSON payloads when focused contract assertions are safer.
- Do not mock so much that the test only proves Mockito was configured correctly.

## Check

Confirm that the smallest sufficient scope proves behavior with realistic infrastructure,
controlled nondeterminism, and the security or regression boundary affected by the change.
