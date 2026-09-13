# Modern Java and API design

Use for Java language choices, public contracts, records, value objects, nullness,
collections, streams, exceptions, and resources.

Optimize for clarity, correctness, and maintainability. Use modern Java features when
they remove meaningful boilerplate, mutable state, unsafe branching, or ambiguity, not
to make code appear modern.

## Model meaning with types

- Use records for transparent data carriers with value semantics: DTOs, commands,
  events, configuration, projections, IDs, and small value objects.
- Records make component references final, not deeply immutable. Defensively copy mutable
  collections or arrays when the contract requires an immutable value.
- A record compact constructor may normalize and validate invariants. Do not turn a
  record into a mutable pseudo-bean or use one for behavior-heavy mutable state.
- Use domain-specific types when raw primitives can be confused or need invariants. Do
  not wrap every primitive when no plausible mixup or invariant exists.
- Use enums or sealed types for genuinely closed concepts. Use exhaustive pattern
  matching when it removes casts or visitor boilerplate, not to make every hierarchy
  sealed.
- Avoid boolean-heavy signatures and `Map<String, Object>` contracts when a named type
  expresses the meaning better.
- Do not add a builder when a record or small constructor is clearer.

## Public API shape

- Keep public APIs small. Use package visibility for implementation details when module
  boundaries permit it.
- Do not create an interface only to add an `Impl` class. Add one for real polymorphism,
  a stable port, multiple implementations, or a boundary that benefits from abstraction.
- Prefer cohesive, named operations over generic `execute(Object)` methods and generic
  base service/repository APIs.
- Preserve source, binary, serialization, and database compatibility when changing an
  established public API unless the task permits a breaking change.
- Validate invariants at construction or state-transition boundaries. Avoid objects that
  remain invalid until a later `validate()` call.

## Language choices

- Prefer switch expressions, arrow cases, and pattern matching when they make branching
  clearer. Do not use fall-through accidentally.
- Use text blocks for real multiline content.
- Use `var` only for locals when the initializer makes the type obvious and the exact
  type is not important to understanding the code.
- Do not use preview features unless the build and user explicitly enable them.

## Collections and streams

- Return empty collections rather than `null`.
- Use immutable factories or defensive copies when callers should not mutate a result.
  Remember that `Stream.toList()` is unmodifiable.
- Use streams for short, side-effect-free transformations. Use loops for complex
  branching, mutation, checked control flow, or when they are easier to read.
- Avoid `parallelStream()` unless measurement proves it helps and use of the common
  fork-join pool is safe.
- Use `EnumSet` and `EnumMap` for enum keys when appropriate.
- Avoid raw types and unchecked casts.

## Null and absence

- Prefer non-null contracts. Use `Optional` mainly as a return type for expected,
  meaningful absence.
- Do not use `Optional` for entity/DTO fields, parameters, or collection elements unless
  an existing API requires it. Prefer an empty collection to `Optional<List<T>>`.
- Do not call `Optional.get()` without immediately proven presence. Use `orElseGet`
  rather than eager `orElse` for expensive or side-effecting fallbacks.
- Preserve the project's nullness model. JSpecify is the natural choice for new
  Framework 7-era code, but do not add annotations or a checker during a focused change
  solely because Spring uses JSpecify.

## Domain behavior and failures

- Keep rules that protect an object's own invariants close to that object. Put
  orchestration across repositories, transactions, and remote clients in an application
  service. Do not force rich-domain modeling onto simple CRUD.
- Throw specific domain/application exceptions for exceptional use-case failure. A
  sealed result type may be clearer when callers branch over several valid outcomes.
- Do not leak JDBC, Hibernate, or HTTP-client exceptions through a public domain API.
  Translate at the boundary and preserve the original cause.
- Catch only exceptions that can be handled meaningfully. Do not swallow failures or log
  and rethrow at every layer.

## Values and resources

- Use `BigDecimal` for exact decimal business amounts. Construct it from strings or
  `BigDecimal.valueOf`, not binary floating-point literals.
- Use `Instant` for timestamps, `LocalDate` for calendar dates, and explicit zones for
  human-local conversion.
- The code that opens an owned `AutoCloseable` should close it with
  try-with-resources. Do not pass open streams or response bodies across layers unless
  ownership transfer and closing are explicit.
- Restore interruption when catching `InterruptedException` without rethrowing it.

## Check

Confirm that every modern feature clarifies the code and is supported by the detected
Java target.
