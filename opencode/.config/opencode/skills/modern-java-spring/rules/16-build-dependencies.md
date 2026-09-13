# Build and dependency rules

Use for Maven/Gradle, Java toolchains, Spring Boot dependency management, annotation
processors, plugins, and dependency changes.

## Preserve the build

- Keep Maven if the project uses Maven; keep Gradle if it uses Gradle.
- Use the wrapper when present.
- Do not add a second build system.
- Respect multi-module boundaries and parent/platform conventions.

## Java level

For Java 21+ projects:

- Prefer Maven `maven.compiler.release` / compiler `release` or a Gradle Java toolchain
  rather than independently drifting source/target/runtime.
- Keep CI, local toolchain, Docker/base runtime, and build target aligned.
- Do not enable preview features unless explicitly required.
- When upgrading Java, verify the build tool and plugins support the target JDK first.

## Spring Boot dependency management

- Let the Spring Boot parent/BOM/platform manage versions for dependencies it owns.
- Do not pin a random explicit version for a managed Spring/Jackson/Hibernate/etc.
  dependency unless a documented compatibility/security reason requires an override.
- Before adding a starter, check whether the project already has the capability via
  another starter/transitive dependency.
- Prefer official starters and maintained integrations over miscellaneous wrappers.

## Maven

- Put direct dependencies in the narrowest correct scope.
- Keep annotation processors configured deliberately for Lombok/MapStruct and verify
  processor compatibility when both are present.
- Keep Surefire/Failsafe responsibilities consistent with the project's unit vs
  integration test convention.
- Use dependency/plugin management in the parent rather than repeating versions across
  modules.
- Prefer Enforcer/toolchains when the repository needs reproducible JDK constraints,
  not as ceremony in every small project.

## Gradle

- Prefer Java toolchains.
- Use the Spring dependency-management/platform approach already present.
- Keep version catalogs/build conventions centralized when the project already uses
  them.
- Avoid dynamic dependency versions in reproducible builds.

## Lombok and MapStruct

- Lombok requires annotation processing. Keep IDE/build processing consistent.
- MapStruct is a compile-time processor; do not add runtime reflection machinery for it.
- When Lombok + MapStruct interact, use the officially supported processor setup for
  the detected versions rather than cargo-culting an old plugin snippet.

## Dependency changes

Before adding a library:

1. check whether JDK/Spring already solves the problem,
2. check whether the project already has an equivalent,
3. prefer a maintained, focused library,
4. add the smallest dependency surface,
5. verify license/security/compatibility when relevant,
6. add tests around behavior that depends on it.

## Verification

- Maven: run the narrowest module test/compile, then broader build if the change is
  cross-module.
- Gradle: use the corresponding targeted task.
- Inspect dependency trees when version conflict or duplicate implementation is
  plausible.

## Check

Confirm build-system preservation, aligned Java targets, managed dependency versions,
annotation processing, and a concrete need for every added dependency.
