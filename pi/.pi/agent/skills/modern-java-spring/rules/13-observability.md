# Observability rules

Use for logging, metrics, tracing, Actuator, health checks, and production diagnostics.

## Logging

- Use the logging facade/style already configured by Spring Boot/project.
- Prefer parameterized logging or the SLF4J fluent API over string concatenation.
- Log events with useful structured context: request/order/job IDs, external system,
  outcome, latency bucket where useful.
- Never log secrets, auth headers, passwords, refresh tokens, private keys, or full
  sensitive payloads.
- Avoid logging the same exception with a stack trace at multiple layers.
- Expected domain/client failures usually belong at INFO/WARN without noisy stack
  traces; unexpected failures belong at the boundary with the exception.
- Do not use `System.out.println` in production code.

## Structured logging

- If the detected Spring Boot line supports built-in structured logging and operations
  consume JSON logs, prefer that over hand-building JSON strings.
- Use low-cardinality keys with stable names.
- Keep free-form detail in the message; keep searchable dimensions in structured
  fields.
- Do not put unbounded user input into labels/tags.

## Metrics

- Use Micrometer/Spring Boot metrics rather than a parallel custom metrics abstraction
  unless the project has one.
- Measure outcomes that answer operational questions: latency, failures, throughput,
  queue depth, cache behavior, downstream calls.
- Metric tags must be low-cardinality. Never tag by user ID, request ID, raw URL,
  exception message, SQL, or arbitrary tenant unless cardinality is intentionally
  bounded.
- Name counters/timers around business/technical events, not implementation method
  names that will churn during refactors.

## Tracing and observations

- Prefer Spring/Micrometer observation instrumentation already provided by the stack.
- Propagate trace context across outbound clients and async boundaries using supported
  framework mechanisms.
- Add custom spans/observations only around meaningful boundaries; do not trace every
  private method.
- Keep trace attributes safe for export.

## Actuator and health

- Expose only the Actuator endpoints operations need.
- Secure management endpoints independently when required.
- Liveness means the process should be restarted if failing.
- Readiness means the instance should temporarily receive no traffic.
- Do not make liveness depend on a flaky downstream and create restart storms.
- Health details can leak infrastructure information; limit exposure appropriately.

## Diagnostics

- Keep enough context in errors/logs to correlate a user-visible failure with a trace
  or request ID.
- For production performance incidents, prefer JFR/profiling evidence over adding
  speculative debug logging everywhere.

## Check

Confirm correlation, bounded metric cardinality, safe telemetry data, correct health
semantics, and reuse of the project's existing observation path.
