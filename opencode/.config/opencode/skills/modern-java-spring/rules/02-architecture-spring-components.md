# Architecture and Spring component rules

Use when adding a feature, changing package boundaries, designing services, wiring Spring
beans, using Lombok, or working with proxy-driven annotations.

## Preserve the project

- Preserve a coherent existing architecture when restructuring is not requested.
- For a new non-trivial feature, prefer package-by-feature. Small features can use fewer
  packages; do not create empty `api`, `application`, `domain`, or `persistence` layers.
- Do not introduce DDD, hexagonal architecture, CQRS, Spring Modulith, or microservices
  because they sound appropriate for Spring. Add structure only for a concrete domain,
  ownership, testing, or deployment need.

A useful greenfield shape, when every part has a purpose, is:

```text
orders/
  api/             HTTP contracts and controllers
  application/     use cases and transaction boundaries
  domain/          domain state and rules, when useful
  persistence/     JPA mappings and repositories/adapters
```

## Responsibilities and dependencies

- Controllers translate HTTP and call application services. They do not own business
  rules, persistence, or transactions.
- Application services own use-case orchestration and transaction boundaries.
- Domain objects own local invariants when meaningful. They should not depend on Spring
  MVC, Jackson, JPA repositories, or web DTOs.
- Repositories persist and query. They are not catch-all business services.
- Keep persistence details out of HTTP contracts and avoid cycles between features.
- Use a narrow interface or event across a real boundary. Do not hide ordinary
  synchronous control flow behind events.

## Avoid generated architecture

- Do not create `FooService` plus `FooServiceImpl` without an alternate implementation,
  stable port, or boundary reason.
- Avoid `Manager`, `Facade`, and pass-through services that only delegate.
- Avoid generic `BaseController`, `BaseService`, and `BaseRepository` types unless they
  encode a proven invariant not already provided by Spring.
- Prefer two tiny obvious mappings over a premature generic mapping framework. Extract
  code when semantics are truly shared, not just because implementations look similar.
- A service with many unrelated dependencies usually has mixed responsibilities. Do not
  hide that with a service locator or extra facade.

## Dependency injection

- Use constructor injection for required collaborators. Omit `@Autowired` when there is
  one constructor.
- Use setter injection only for genuinely optional or reconfigurable dependencies.
- More than roughly five to seven constructor dependencies is a smell to investigate,
  not a threshold or reason to use field injection.
- Use stereotypes intentionally and `@Bean` for third-party objects or explicit
  construction.
- Prefer Spring Boot auto-configuration and documented customization hooks over
  recreating framework infrastructure manually.
- Use `@Configuration(proxyBeanMethods = false)` when inter-bean method calls do not
  require full configuration proxies.
- Avoid mutable global state, static service locators, and unnecessary bean scopes.

## Proxies and lifecycle

- `@Transactional`, `@Async`, caching, and method security are commonly proxy-based.
  Self-invocation can bypass advice; private methods cannot be intercepted through the
  usual proxy call path.
- Do not make methods or classes final when the detected proxy mechanism requires
  subclassing. Prefer one visible boundary method over annotation scattering.
- Keep constructors free of database and network work. Use an explicit lifecycle
  mechanism only when startup or shutdown ordering is part of the requirement.
- Give owned clients, executors, and resources an explicit shutdown path.
- Treat circular dependencies as a design failure. Do not hide one with field injection
  or `@Lazy`, except as an explicitly accepted temporary migration workaround.

## Lombok

Use Lombok only when the project accepts it and it removes mechanical boilerplate.

- `@RequiredArgsConstructor` is fine for simple Spring beans with final dependencies.
- `@Slf4j` and selective `@Getter` are fine when they match project style.
- Use `@Builder` only when many optional construction values make it clearer than a
  constructor or record.
- Do not use `@Data` on JPA entities or invariant-rich domain objects.
- Do not generate entity equality mechanically or include lazy associations, secrets,
  or bidirectional graphs in `toString`.
- Avoid `@SneakyThrows`, class-level `@Setter`, and entity builders that bypass required
  state.

## Check

Confirm that every added layer, interface, bean, and Lombok annotation has a concrete
purpose and that proxy advice can intercept its intended call path.
