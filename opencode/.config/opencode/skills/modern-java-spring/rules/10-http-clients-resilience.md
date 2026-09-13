# HTTP client and resilience rules

Use for outbound HTTP, RestClient, HTTP Service Clients, WebClient, timeouts, retries,
rate limits, and circuit breakers.

## Client choice

- On Spring Framework 6.1+ / Spring Boot 3.2+, prefer `RestClient` for new
  synchronous clients. HTTP Service Clients exist since Framework 6.0, but a
  `RestClient`-backed proxy requires Framework 6.1+.
- On older lines, preserve the available client unless upgrading is part of the task.
- For an intentionally reactive/streaming application, use `WebClient`.
- `RestTemplate` is deprecated starting with Spring Framework 7. Preserve existing
  usages unless migration provides a concrete benefit.
- Centralize client construction/configuration rather than building a new client per
  request.

## Required client configuration

Every production remote client should have intentional:

- connect timeout,
- read/response timeout,
- base URL,
- authentication,
- error mapping,
- observability/correlation behavior where the stack supports it.

Do not rely on unbounded/default timeouts without checking the underlying request
factory/client.

## Contracts

- Use typed request/response DTOs.
- Keep external provider DTOs at the integration boundary; map into internal types.
- Do not pass provider-specific exceptions deep into the domain.
- Validate/limit response sizes for untrusted or potentially huge payloads when
  relevant.
- Avoid arbitrary user-controlled target URLs. Protect against SSRF with fixed hosts or
  strict allowlists. For user-influenced destinations, disable automatic redirects or
  validate every redirect target, and reject resolved loopback, link-local, private,
  and metadata-service addresses where the destination is not fixed.

## Retries

- Retry only failures likely to be transient.
- Prefer retrying idempotent operations. For non-idempotent operations, require an
  idempotency mechanism or explicit proof of safety.
- Use bounded attempts, exponential backoff, and jitter.
- Respect `Retry-After` where appropriate.
- Do not retry validation failures, most 4xx responses, or deterministic business
  failures.
- Ensure total deadline includes all retry attempts.
- Keep retry ownership in one layer when possible. Stacked framework, client, and caller
  retries can multiply attempts and exceed the intended deadline.

## Circuit breakers and bulkheads

- Add Resilience4j/Spring retry/circuit behavior only when the project already uses it
  or the failure mode justifies the dependency.
- A circuit breaker is not a substitute for timeouts.
- Keep metrics on retries/circuit state low-cardinality and actionable.
- Bound concurrency to fragile downstreams when request fan-out can overwhelm them.

## Transactions

- Avoid holding a database transaction open across slow remote calls when the workflow
  can be split.
- If a remote side effect and DB commit need reliability, use an explicit consistency
  strategy (outbox, idempotency, saga/workflow), not nested try/catch hope.

## Check

Confirm client availability on the detected Spring line, bounded deadlines, single-layer
retry ownership, SSRF controls, and transaction scope around the call.
