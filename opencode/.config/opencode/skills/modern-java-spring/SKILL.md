---
name: modern-java-spring
description: >-
  Use when writing, reviewing, refactoring, debugging, testing, or modernizing
  Java 21+ and Spring Boot code. Covers modern Java, Spring MVC, Spring Data
  JPA/Hibernate, transactions, REST, validation, Spring Security, Lombok,
  MapStruct, Jackson, migrations, Testcontainers, Micrometer, Maven/Gradle,
  virtual threads, performance, integrations, and upgrades. This is a
  progressive-disclosure router: inspect the project and read only the matching
  rules/*.md files.
---

# Modern Java + Spring

Route the task to focused rules. Do not read the whole `rules/` directory.

## Global rules

1. Detect the Java version, Spring Boot version, and build system before recommending
   APIs, dependencies, or commands.
2. Preserve the repository's established architecture, naming, and testing conventions
   unless the task explicitly asks to change them.
3. Do not assume that APIs from the latest Java or Spring release are available. Check
   the project's configured versions first.
4. Run the narrowest meaningful build, test, or static check for the affected code.

## Routing protocol

1. Inspect only enough repository evidence to identify the relevant stack, local
   conventions, and affected boundary.
2. Select and read one primary rule, then start investigating the change.
3. Load a supporting rule only after evidence shows that implementation crosses that
   concern. Load a second only for a concrete unresolved risk.
4. If work later reveals another material correctness or security concern, load its rule;
   the context target is not permission to ignore a discovered risk.
5. If no row fits, search rule filenames and headings for the concrete technology or
   failure boundary. Do not enumerate or preload every file.
6. Existing repository choices beat greenfield defaults unless migration or
   restructuring is requested.

Target at most 1,200 rule words for a normal task, excluding this router.

## Routes

| Task signal | Read this primary rule | Then read only when evidence requires it |
|---|---|---|
| Greenfield/broad project or unclear conventions | `rules/00-project-baseline.md` | concrete implementation concern |
| Java syntax, API contracts, records, Optional, streams, nullness, exceptions | `rules/01-java-api-design.md` | none by default |
| Packages, services, beans, DI, Lombok, modules, structural refactor | `rules/02-architecture-spring-components.md` | `rules/19-code-review.md` for a broad refactor audit |
| Controller, REST, validation, exceptions, ProblemDetail, pagination, uploads | `rules/03-web-validation-errors.md` | `rules/11-security.md` for an exposed security boundary |
| DTO mapping, MapStruct, Jackson, serialization | `rules/04-dtos-mapping-jackson.md` | `rules/03-web-validation-errors.md` for an HTTP contract change |
| JPA entity, association, cascade, equality, IDs, optimistic locking | `rules/05-jpa-model.md` | `rules/07-transactions.md` when atomicity or locking changes |
| Repository query, N+1, fetch plan, projection, pagination, bulk update | `rules/06-jpa-queries.md` | model or transaction rule only for a concrete interaction |
| Transaction, propagation, isolation, locking, rollback, unit of work | `rules/07-transactions.md` | HTTP-client rule if a network call crosses the transaction |
| Flyway, Liquibase, DDL, index, data migration | `rules/08-database-migrations.md` | query rule when a query plan drives the schema change |
| ConfigurationProperties, profiles, environment, secrets | `rules/09-config-secrets.md` | security rule for credentials or exposed configuration |
| RestClient, HTTP interfaces, WebClient, retries, circuit breakers, SSRF | `rules/10-http-clients-resilience.md` | concurrency rule for parallel/fan-out calls |
| Authentication, authorization, OAuth2/JWT, CORS, CSRF, unsafe input | `rules/11-security.md` | web rule for HTTP contract behavior |
| JUnit, Mockito, AssertJ, slices, Spring tests, Testcontainers | `rules/12-testing.md` | production rule only when test design depends on its semantics |
| Logging, Micrometer, tracing, Actuator, health | `rules/13-observability.md` | configuration rule for exposure/settings |
| Virtual threads, executors, Async, futures, locks, shared state | `rules/14-concurrency-virtual-threads.md` | performance rule only when measurement is part of the task |
| Slow code, SQL cost, GC, JFR, allocation, caching, pool sizing | `rules/15-performance.md` | query or concurrency rule for the measured bottleneck |
| pom.xml, Gradle, BOM, plugins, annotation processors, dependencies | `rules/16-build-dependencies.md` | modernization rule only for an upgrade |
| Events, scheduling, jobs, Kafka/messaging, outbox | `rules/17-spring-events-jobs-messaging.md` | transaction or observability rule for a concrete guarantee |
| Java/Spring upgrade, javax to jakarta, deprecation cleanup | `rules/18-modernization-migrations.md` | build rule, then only affected target rules |
| Bug/regression | rule owning the failing boundary | `rules/12-testing.md` for the regression test |
| Broad code review, generated-code cleanup, mergeability audit | `rules/19-code-review.md` | only rules implicated by concrete findings |

## Completion

Before finishing:

1. Check the changed behavior against the primary rule.
2. Inspect the diff for unrelated modernization, new dependencies, and accidental public
   contracts.
3. Run the narrowest meaningful verification available.
4. Report what was and was not verified.
