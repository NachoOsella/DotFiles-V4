# Common Architecture Patterns

Reference guide for recognizing MVC, Clean Architecture, and Hexagonal Architecture in unfamiliar codebases across different languages.

---

## MVC (Model-View-Controller)

**Core idea**: Separates data (Model), UI (View), and request handling (Controller).

### How to Recognize

Look for three distinct directories or file groups:
- **Models**: Data classes, ORM entities, database schemas
- **Views**: Templates, JSX/Vue components, HTML generators
- **Controllers**: Route handlers, request dispatchers, action classes

### Language/Framework Examples

| Language | Typical Directories | Notes |
|----------|---------------------|-------|
| Ruby (Rails) | `app/models`, `app/views`, `app/controllers` | Strong convention; easy to spot |
| Python (Django) | `<app>/models.py`, `<app>/views.py`, `<app>/templates` | Django calls views what Rails calls controllers |
| PHP (Laravel) | `app/Models`, `resources/views`, `app/Http/Controllers` | Laravel adds Service/Repository layers on top |
| Java (Spring) | `model/`, `controller/`, `templates/` or `static/` | Spring Boot often uses Thymeleaf or REST controllers |
| JavaScript (Express) | `models/`, `views/`, `routes/` or `controllers/` | Less rigid; often evolves into layered architecture |
| C# (ASP.NET) | `Models/`, `Views/`, `Controllers/` | Scaffolded by default in MVC projects |

### Warning Signs
- In frontend frameworks (React, Vue, Angular), "component" is not a View in the MVC sense. The pattern may not apply.
- Many modern backends start as MVC but grow Service/Repository layers on top, making it look like Clean Architecture.

---

## Clean Architecture

**Core idea**: Dependencies point inward. Domain logic has zero external dependencies. Frameworks, UI, and databases are "plugins."

### How to Recognize

Look for concentric dependency layers, usually expressed as directories:

```
entities/          -> Enterprise business rules (pure domain)
usecases/          -> Application business rules (orchestration)
interface/         -> Adapters: controllers, presenters, gateways
framework/         -> Drivers: web framework, database, external APIs
```

Or in a flatter layout:

```
domain/            -> Entities, value objects, domain services
application/       -> Use cases, ports (interfaces), DTOs
infrastructure/    -> Repositories, controllers, external clients
```

### Key Indicators
- A `domain/` or `entities/` directory with no imports from outer layers (no HTTP, no ORM, no framework)
- Interfaces (ports) defined in inner layers, implemented in outer layers
- Use case classes with names like `CreateOrder`, `SendNotification`, `ProcessPayment`
- DTOs mapping between layers

### Language/Framework Examples

| Language | Typical Directories | Notes |
|----------|---------------------|-------|
| TypeScript/Node | `src/domain`, `src/application`, `src/infrastructure` | Common in NestJS or Express with explicit architecture |
| Java | `domain/`, `application/`, `infrastructure/`, `interfaces/` | Spring Boot projects often adopt this with packages |
| Python | `domain/`, `usecases/`, `adapters/`, `infra/` | Less common than MVC; look for absence of Django/Flask patterns |
| Go | `internal/domain`, `internal/usecase`, `internal/delivery`, `internal/repository` | Go projects often flatten it; check import direction |
| C# | `Domain`, `Application`, `Infrastructure`, `WebApi` | Very common in .NET microservices |
| PHP | `src/Domain`, `src/Application`, `src/Infrastructure` | Used in Symfony/Laravel when moving beyond MVC |

### Warning Signs
- Clean Architecture is often *aspirational*. Check if `domain/` actually has no framework imports. If it imports `sqlalchemy`, `mongoose`, or `spring`, it is not Clean Architecture.
- Names vary: "Onion Architecture" and "Ports and Adapters" are close relatives with nearly identical directory layouts.

---

## Hexagonal Architecture (Ports and Adapters)

**Core idea**: The application core defines **ports** (interfaces). Everything outside implements **adapters**. The core does not know about HTTP, SQL, message queues, etc.

### How to Recognize

Directory names often include:
- `port/` or `ports/` (interfaces for incoming and outgoing concerns)
- `adapter/` or `adapters/` (implementations: REST controllers, DB repositories, message publishers)
- `domain/` or `core/` (the application logic, oblivious to adapters)
- `application/` or `service/` (orchestration layer)

Typical layout:

```
src/
  domain/          -> Business logic, aggregates, domain events
  application/     -> Services/ports that orchestrate domain objects
  adapter/
    in/
      web/         -> REST controllers, CLI handlers, message consumers
    out/
      persistence/ -> Repository implementations, DAOs
      external/    -> Third-party API clients
```

### Key Indicators
- Interface names like `OrderRepository`, `PaymentGateway`, `NotificationPort`, `UserStore`
- Concrete implementations named with technology: `PostgresOrderRepository`, `StripePaymentAdapter`, `SnsNotificationClient`
- The `domain/` or `core/` directory imports nothing from `adapter/`
- Dependency injection wiring everything together in a main/startup file

### Language/Framework Examples

| Language | Typical Directories | Notes |
|----------|---------------------|-------|
| Java | `domain/`, `application/port/`, `adapter/in/`, `adapter/out/` | Very explicit in Spring Boot microservices |
| TypeScript | `core/`, `ports/`, `adapters/`, `infra/` | Common in domain-driven designs on Node |
| Python | `domain/`, `ports/`, `adapters/`, `app/` | Rare in Django; look in FastAPI/Flask custom architectures |
| Go | `internal/core`, `internal/ports`, `internal/adapters` | Go favors flat packages; look for interface/impl separation |
| Kotlin | `domain/`, `ports/`, `adapters/`, `config/` | Similar to Java, often with Spring |

### Warning Signs
- Hexagonal and Clean Architecture directories are often **mixed or renamed**. A project may call ports "interfaces" and adapters "implementations."
- If there are no explicit ports (interfaces) and the domain directly instantiates `new PostgresClient()`, it is not hexagonal.
- Many teams claim hexagonal but only use it for the database layer (repository pattern). Check if external APIs and messaging are also behind ports.

---

## Quick Comparison

| Pattern | Core Principle | Directory Clues | Red Flags |
|---------|---------------|-----------------|-----------|
| MVC | Separation of data, UI, and control | `models/`, `views/`, `controllers/` | View and controller logic mixed in models ("fat models") |
| Clean Architecture | Dependencies point inward | `domain/`, `usecases/`, `interface/`, `framework/` | Inner layers import outer layers |
| Hexagonal | Core defines ports, outside provides adapters | `domain/`, `ports/`, `adapters/`, `infra/` | Domain directly uses concrete external clients |

---

## Cross-Language Directory Mapping

When mapping architecture, match directory names to the pattern layer regardless of language:

| Layer | MVC | Clean Architecture | Hexagonal |
|-------|-----|-------------------|-----------|
| Domain logic | `models/` | `domain/`, `entities/` | `domain/`, `core/` |
| Orchestration | `controllers/` | `usecases/`, `application/` | `application/`, `service/` |
| Interface | `views/` | `interface/` | `ports/`, `adapter/in/` |
| Infrastructure | (often mixed) | `framework/`, `infrastructure/` | `adapter/out/`, `infra/` |
