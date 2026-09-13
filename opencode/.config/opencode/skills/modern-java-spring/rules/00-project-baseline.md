# Project baseline and greenfield defaults

Use only when the task is broad, repository conventions are unclear, or a new
Java/Spring module needs defaults. Focused maintenance should use the owning rule.

## Inspect before choosing

Establish only what affects the request:

- Java target/runtime and whether preview features are enabled;
- Spring Boot and Framework versions;
- Maven or Gradle configuration and managed dependencies;
- persistence technology and database when data is involved;
- package/module boundaries and nearby conventions;
- existing test style and the narrowest useful verification command.

Existing repository constraints beat these defaults unless modernization, migration, or
architecture change is requested.

## Greenfield choices

- Choose a currently supported LTS Java release, minimum 21, and avoid preview features
  unless explicitly requested.
- Prefer clear code, immutable values where practical, and explicit state changes.
- Use constructor injection and package-by-feature for non-trivial features. Do not
  create empty layers.
- Use Spring MVC for normal blocking services. Introduce WebFlux only for a concrete
  reactive or streaming requirement.
- Use JPA/Hibernate when object-relational persistence fits; do not force it onto
  SQL/query-centric workloads.
- Keep API contracts separate from persistence entities and place transactions at
  application use-case boundaries.
- Choose the migration, mapping, test, and observability tools justified by the project.
  Do not add every supported library to establish a baseline.

## Change discipline

- Prefer the smallest safe diff.
- Do not upgrade dependencies, change build systems, introduce reactive/concurrent code,
  or restructure unrelated packages unless required.
- Verify version-sensitive APIs and properties against official documentation for the
  detected line.
- Compile and run the narrowest relevant tests when tooling is available.

## Check

Confirm that project evidence, not generic defaults, determined every material choice.
