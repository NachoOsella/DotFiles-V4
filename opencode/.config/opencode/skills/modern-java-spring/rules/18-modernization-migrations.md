# Modernization and migration rules

Use when upgrading Java or Spring, moving Jakarta namespaces, replacing removed APIs, or
modernizing an older codebase deliberately.

## Separate compatibility from cleanup

- First make the project run correctly on the target platform. Then modernize syntax and
  APIs in small verified passes.
- Do not combine a Java/Spring major upgrade with an architecture rewrite unless the user
  requests both.
- Keep migration steps buildable and testable where practical. Do not guess a target
  version.

## Detect before editing

Identify source and target versions for:

- Java, Spring Boot, and Spring Framework;
- Maven/Gradle wrappers, compiler plugins, and test plugins;
- Servlet/Jakarta APIs, Hibernate, database driver, and migration tool;
- test annotations and Spring test modules;
- generated code, Lombok, MapStruct, and other annotation processors;
- CI, container, native-image, and deployment runtimes.

## Major upgrades

- Read official migration and release notes for every crossed major line.
- Upgrade to the latest compatible patch of the current major first when the migration
  guide recommends it.
- Resolve deprecations before their removal where possible.
- For Boot 2 to 3, account for Jakarta namespace changes and third-party compatibility.
  Do not replace every `javax.*` import blindly; Java SE still owns some `javax`
  packages.
- For Boot 3 to 4 / Framework 7, verify removed APIs, modularized dependencies and test
  imports, JSpecify nullness, HTTP clients, servlet baseline, and third-party starters.
- Boot 4 uses Jackson 3 with `tools.jackson` packages. Migrate mapper imports, modules,
  and custom configuration together; do not mix Jackson 2 and 3 APIs accidentally.

## Version-gated replacements

- `RestClient` requires Framework 6.1+ and is managed by Boot 3.2+. `RestTemplate` is
  deprecated starting with Framework 7; preserve it when the source line lacks the
  replacement or HTTP-client migration is out of scope.
- `@MockitoBean` requires Framework 6.2+ / Boot 3.4+. Keep `@MockBean` on Boot 3.3 and
  earlier; it is deprecated in Boot 3.4 and removed from Boot 4.
- Apply language, virtual-thread, nullness, serialization, and test changes only after
  the target build supports them and the affected rule justifies the change.

## Automation and verification

- OpenRewrite or framework migration tooling can accelerate mechanical changes. Treat
  automated rewrites as a diff generator, not proof of correctness.
- Review generated changes and do not edit generated output when its source or generator
  can be changed.
- Verify in this order: toolchain and dependency resolution, compile, unit tests,
  persistence/integration tests, startup/smoke tests, deployment-specific checks, then a
  performance baseline when runtime behavior may change materially.

## Check

Confirm compatibility on the target platform before optional cleanup, with aligned build,
CI, container, and runtime versions.
