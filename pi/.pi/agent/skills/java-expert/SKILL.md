---
name: java-expert
description: Use when designing, implementing, refactoring, testing, or reviewing Java, Spring Boot, Hibernate/JPA, REST APIs, batch jobs, or JVM production code with emphasis on maintainability, clean architecture, security, observability, and performance.
---

# Java Expert

Generate production-quality Java and Spring Boot code that is easy to read, test, evolve, and operate. Prefer explicit, boring, maintainable designs over clever abstractions.

## Default Approach

1. First inspect the existing project conventions: package layout, Java version, Spring Boot version, build tool, test stack, mapping style, exception model, and naming.
2. Match existing conventions unless they are harmful; explain any deliberate deviation.
3. Keep responsibilities separated: controllers handle HTTP, services handle use cases and transactions, repositories handle persistence, entities model persistence/domain state, DTOs model API contracts.
4. Prefer small cohesive classes and methods. Avoid generic utility layers, premature abstractions, and reflection-heavy solutions unless the project already uses them.
5. Include tests for behavior, validation, persistence queries, and error cases when changing production code.
6. For new Spring code, assume Spring Boot 3+, Jakarta packages, Java 17+ minimum, and Java 21 features only when the project supports them.

## Quality Bar for Generated Code

Every generated implementation should satisfy these checks:

- Clear package and class names that reveal intent.
- Constructor injection for required dependencies; no field injection.
- No business logic in controllers, repositories, mappers, or entity accessors.
- DTOs at API boundaries; never return JPA entities directly from controllers.
- Bean Validation on request DTOs and method parameters where applicable.
- Consistent exception handling with `ProblemDetail` or the project's existing error format.
- Explicit transaction boundaries in services, with `readOnly = true` for reads.
- Pagination for unbounded collection endpoints.
- Structured logging for important decisions and failures, without logging secrets or personal data.
- Tests that use realistic dependencies: slice tests for MVC/JPA, Testcontainers for database-specific behavior, unit tests for pure domain logic.

## Spring Boot Architecture

### Recommended Package Layout

Use feature-based packaging for medium and large applications because it keeps related code together and reduces cross-feature coupling.

```text
com.example.app
└── product
    ├── api              # Controllers, request/response DTOs, API exception mapping if feature-specific
    ├── application      # Use-case services, transaction boundaries, orchestration
    ├── domain           # Domain concepts, policies, domain exceptions
    └── persistence      # JPA entities, repositories, persistence mappers
```

For small projects, a simpler `controller/service/repository` layout is acceptable if it already exists.

### Controller Rules

Controllers translate HTTP to application calls. They should not contain persistence logic or business rules.

```java
@RestController
@RequestMapping("/api/products")
@RequiredArgsConstructor
@Validated
class ProductController {
    private final ProductService productService;

    @GetMapping
    Page<ProductResponse> findProducts(Pageable pageable) {
        // Pagination prevents accidental full-table responses.
        return productService.findProducts(pageable);
    }

    @PostMapping
    ResponseEntity<ProductResponse> createProduct(
            @Valid @RequestBody CreateProductRequest request,
            UriComponentsBuilder uriBuilder) {
        ProductResponse created = productService.createProduct(request);
        URI location = uriBuilder.path("/api/products/{id}")
                .buildAndExpand(created.id())
                .toUri();
        return ResponseEntity.created(location).body(created);
    }
}
```

### Service Rules

Services own use cases, transactions, authorization-sensitive decisions, and orchestration.

```java
@Service
@RequiredArgsConstructor
class ProductService {
    private final ProductRepository productRepository;
    private final ProductMapper productMapper;

    @Transactional(readOnly = true)
    Page<ProductResponse> findProducts(Pageable pageable) {
        return productRepository.findAll(pageable).map(productMapper::toResponse);
    }

    @Transactional
    ProductResponse createProduct(CreateProductRequest request) {
        if (productRepository.existsBySku(request.sku())) {
            throw new DuplicateResourceException("Product SKU already exists");
        }

        Product product = productMapper.toEntity(request);
        Product savedProduct = productRepository.save(product);
        return productMapper.toResponse(savedProduct);
    }
}
```

## DTOs, Mapping, and Validation

- Use records for immutable request/response DTOs and projections.
- Use classes for JPA entities; records are not appropriate for entities.
- Validate request DTOs with Jakarta Bean Validation.
- Use MapStruct for repetitive mapping when the project uses it; otherwise write small explicit mappers.
- Do not expose internal IDs, flags, or audit fields unless the API contract requires them.

```java
public record CreateProductRequest(
        @NotBlank @Size(max = 120) String name,
        @NotBlank @Size(max = 64) String sku,
        @NotNull @Positive BigDecimal price
) {
}

public record ProductResponse(
        Long id,
        String name,
        String sku,
        BigDecimal price
) {
}
```

## JPA and Hibernate Rules

- Model entities as regular classes with protected no-args constructors for JPA.
- Prefer `LAZY` associations. Fetch what each use case needs with projections, entity graphs, or fetch joins.
- Avoid `CascadeType.ALL` and `orphanRemoval = true` unless aggregate ownership is clear.
- Avoid Lombok `@Data` on entities because generated `equals`, `hashCode`, and `toString` can trigger lazy loading and recursion.
- Use optimistic locking (`@Version`) for concurrently updated aggregates.
- Keep database constraints aligned with Bean Validation and business rules.
- Do not use Open Session in View as a substitute for correct fetching and DTO mapping.

```java
@Entity
@Table(name = "products", uniqueConstraints = @UniqueConstraint(name = "uk_products_sku", columnNames = "sku"))
class Product {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Version
    private long version;

    @Column(nullable = false, length = 120)
    private String name;

    @Column(nullable = false, length = 64, updatable = false)
    private String sku;

    @Column(nullable = false, precision = 19, scale = 2)
    private BigDecimal price;

    protected Product() {
        // Required by JPA.
    }

    Product(String name, String sku, BigDecimal price) {
        this.name = name;
        this.sku = sku;
        this.price = price;
    }
}
```

## Error Handling

Prefer a single `@RestControllerAdvice` using RFC 7807 `ProblemDetail` unless the project already has a standard error contract.

```java
@RestControllerAdvice
class ApiExceptionHandler {
    @ExceptionHandler(ResourceNotFoundException.class)
    ResponseEntity<ProblemDetail> handleNotFound(ResourceNotFoundException exception) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, exception.getMessage());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(problem);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ProblemDetail> handleValidation(MethodArgumentNotValidException exception) {
        ProblemDetail problem = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        Map<String, String> errors = exception.getBindingResult().getFieldErrors().stream()
                .collect(Collectors.toMap(
                        FieldError::getField,
                        FieldError::getDefaultMessage,
                        (first, second) -> first,
                        TreeMap::new));
        problem.setProperty("errors", errors);
        return ResponseEntity.badRequest().body(problem);
    }
}
```

## Testing Strategy

Choose the narrowest useful test type:

- Pure unit tests for domain logic, mappers, validators, and services with mocked ports.
- `@WebMvcTest` for controller routing, validation, serialization, and error handling.
- `@DataJpaTest` for repositories, mappings, constraints, and custom queries.
- `@SpringBootTest` with Testcontainers for end-to-end integration paths.

Good tests should cover happy path, validation failures, not-found cases, authorization failures when relevant, and database constraint behavior.

## Security, Observability, and Operations

- Validate and authorize at the boundary and again in services for sensitive operations.
- Never log credentials, tokens, full request bodies with personal data, or secrets.
- Use parameterized logs: `log.info("Created product id={}", productId)`.
- Add Micrometer metrics only for meaningful business or operational signals.
- Prefer configuration properties with validation for externalized settings.
- Make external calls timeout-bound and retry only idempotent operations.

## Modern Java Guidance

- Use records for immutable data carriers, not entities.
- Use sealed types when modeling a closed set of outcomes improves exhaustiveness.
- Use `Optional` as a return type, not as an entity field or DTO field.
- Use streams for straightforward transformations; use loops when they are clearer.
- Use virtual threads for high-concurrency I/O-bound workloads only when running on Java 21+ and dependencies are compatible.

## Common Spring/Hibernate Gotchas

### `@Transactional` Can Be Ignored

Spring proxy-based annotations do not apply to self-invocation, private methods, or final methods/classes in common proxy modes. Put transactional use cases on public service methods called from another bean.

### Lazy Loading Leaks

Returning entities from services or controllers often causes `LazyInitializationException` or accidental N+1 queries. Fetch and map inside the transaction.

### Entity Equality Is Subtle

Do not generate entity equality from all fields. Prefer stable business keys when available, or carefully implement ID-based equality only after persistence identity is assigned.

### Events and Side Effects

Do not send emails, publish messages, or call remote services before the database transaction commits. Prefer transactional outbox or `@TransactionalEventListener(phase = AFTER_COMMIT)` for simple cases.

## When to Read References and Assets

- Read `references/spring-boot-design-patterns.md` for detailed controller/service/repository patterns.
- Read `references/hibernate-configuration-guide.md` for fetch strategy, caching, and Hibernate tuning.
- Use `assets/rest-controller-template.java` when creating a new REST controller skeleton.
- Use `assets/testcontainers-test-template.java` when adding integration tests with PostgreSQL.
- Use `assets/application.yml` as a baseline Spring Boot configuration, adapting it to the project.

## Final Response Expectations

When reporting changes, mention the files changed, tests run, and any important trade-offs. If tests could not be run, explain why and provide the exact command the user can run.
