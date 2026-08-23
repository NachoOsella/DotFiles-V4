# Spring MVC, validation, and error rules

Use for controllers, HTTP contracts, pagination, Bean Validation, exceptions, and
`ProblemDetail` responses.

## Choose the web model

- Prefer Spring MVC for services built on blocking JDBC/JPA and blocking clients.
- Use WebFlux only for an intentionally reactive end-to-end system or a concrete
  streaming/backpressure requirement. Do not wrap blocking JPA calls in `Mono` or `Flux`.

## Controllers and contracts

- Controllers own routing, binding, validation triggers, status, headers, and translation
  to application calls. Keep business rules and transactions elsewhere.
- Inject an application/service dependency, not repositories directly.
- Use request and response DTOs. Never accept or serialize JPA entities as HTTP
  contracts. Records fit stable shapes that do not need mutation.
- Return a DTO directly when status and headers are fixed. Use `ResponseEntity` when the
  method genuinely controls them.

## HTTP semantics

- Use resource-oriented paths and normal HTTP method semantics.
- Return `201 Created` and `Location` when a resource was created and its URI is known.
- Use `PUT` for genuinely idempotent replacement/upsert semantics. Define PATCH absent
  versus explicit-null behavior.
- `DELETE` should be idempotent from the client's perspective.
- Use `202 Accepted` only when processing continues after the response and `204 No
  Content` when no representation is returned deliberately.
- Do not make breaking API changes silently. Follow the repository's versioning and
  compatibility strategy.

## Input and validation

- Validate syntactic request constraints on inbound DTOs with Jakarta Bean Validation.
  Use `@Valid` for nested request-object validation.
- On Spring Framework 6.1+, constraints directly on controller parameters use MVC's
  built-in method validation. Do not add class-level `@Validated` to controllers
  mechanically; it switches validation to an AOP path.
- Keep business invariants in domain/application code because HTTP validation does not
  protect jobs, messages, or internal callers.
- Treat path, query, header, and body values as untrusted input.
- Explicitly bound pagination size and allowlist client-controlled sort properties.
- For uploads, enforce size and permitted content. Do not trust original filenames or
  client-declared MIME types; generate storage names and inspect content when type affects
  security.

## Pagination

- Use deterministic sorting when pages must be stable.
- Offset pagination fits ordinary shallow browsing. Consider keyset/seek pagination for
  deep or high-volume traversal.
- Do not expose an unbounded collection endpoint.
- Do not page a root query with a to-many fetch join unless the detected Hibernate and
  database combination is proven to execute it safely.
- Preserve the project's public pagination shape rather than leaking a new Spring
  `Page`/`Pageable` contract accidentally.

## Exceptions and HTTP errors

- Throw specific application/domain exceptions for use-case failures. Do not catch
  `Exception` to return `false`, `null`, or an empty result.
- Centralize REST exception mapping with `@RestControllerAdvice`.
- Prefer Spring `ProblemDetail` and `ErrorResponse` support over inventing a wrapper for
  every service, unless the project already has a stable error contract.
- When customizing MVC validation responses on Framework 6.1+, account for both
  `MethodArgumentNotValidException` and `HandlerMethodValidationException`.
- Use stable machine-readable error codes or types. Never expose Java exception names,
  stack traces, SQL, internal URLs, secrets, or raw downstream bodies.
- Add validation field errors, a request/correlation ID, or a domain code only when
  clients need them.

Typical status mapping:

- malformed input or failed validation: 400;
- unauthenticated: 401;
- authenticated but forbidden: 403;
- missing resource: 404;
- state, version, or uniqueness conflict: 409;
- unsupported media type or method: framework-standard 415 or 405;
- unexpected failure: 500 with generic public detail.

The API contract can justify a different mapping; do not force every domain rule into
this list.

## Logging failures

- Log unexpected failures once at a boundary with the exception.
- Expected 4xx failures normally do not need an ERROR stack trace.
- Include useful identifiers as structured context, never secrets or sensitive payloads.

## Check

Confirm that HTTP semantics, validation path, pagination bounds, and public error payload
match the detected Spring version and existing API contract.
