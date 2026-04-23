---
name: java-expert
description: Use for expert Java, Spring Boot, Hibernate, and JVM apps.
---

# Java Development

## Modern Java Features (17+)

```java
// Records for DTOs
public record UserDTO(String name, String email) {}

// Pattern matching
if (obj instanceof String s && s.length() > 5) {
    System.out.println(s.toUpperCase());
}

// Text blocks
String json = """
    {
        "name": "%s",
        "email": "%s"
    }
    """.formatted(name, email);

// Sealed classes
public sealed interface Result permits Success, Failure {}
public record Success<T>(T data) implements Result {}
public record Failure(String error) implements Result {}

// Virtual Threads (JDK 21+)
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    executor.submit(() -> handleRequest(request));
}
```

## Spring Boot 3

```java
@RestController
@RequestMapping("/api/users")
public class UserController {
    private final UserService userService;
    
    public UserController(UserService userService) {
        this.userService = userService;
    }
    
    @GetMapping("/{id}")
    public ResponseEntity<UserDTO> getUser(@PathVariable Long id) {
        return userService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }
}
```

## Data Layer with JPA/Hibernate

```java
@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    
    @Column(nullable = false)
    private String name;
    
    @Column(nullable = false, unique = true)
    private String email;
    
    // Getters and setters
}

@Repository
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);
}
```

## Testing with Testcontainers

```java
@Testcontainers
@SpringBootTest
class UserRepositoryTest {
    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:15");
    
    @Test
    void shouldSaveUser() {
        // Test with real database
    }
}
```

## Gotchas

### Lazy Initialization and @Transactional
Lazy-loaded associations outside a transactional context trigger `LazyInitializationException`. Spring's `@Transactional` opens a session bound to the thread, but if you return an entity from a `@Transactional` method and access a lazy collection in the controller or response serializer, the session is already closed.

**Fix:** Use `OpenEntityManagerInViewFilter` only as a last resort. Prefer:
- Fetch joins (`JOIN FETCH`) in repository queries
- DTO projections to fetch only needed data
- Transactional boundaries that encompass serialization (e.g., map to DTOs inside `@Transactional` service methods)

```java
@Query("SELECT u FROM User u JOIN FETCH u.orders WHERE u.id = :id")
Optional<User> findByIdWithOrders(@Param("id") Long id);
```

### CGLIB Proxies Require Non-Private, Non-Final Methods
Spring Boot uses CGLIB subclassing for proxying by default (when no interface is implemented). `private` and `final` methods cannot be intercepted by CGLIB proxies, so `@Transactional`, `@Cacheable`, `@Async`, and `@PreAuthorize` have no effect on them.

**Fix:** Keep `@Transactional` methods `public` (or package-private if using AspectJ weaving) and never `final`. If you must use `final`, switch to interface-based JDK proxies (`spring.aop.proxy-target-class=false`) and program to interfaces.

```java
// BAD: @Transactional is ignored here
@Transactional
private void updateInternal(User user) { ... }

// GOOD
@Transactional
public void updateUser(User user) { ... }
```

### Records Do Not Work Well with JPA Entities
JPA requires a no-args constructor, non-final fields (or property accessors), and mutable state for dirty checking and proxy generation. Java `record` classes are implicitly `final`, have no setter methods, and are designed for immutability. Using a `record` as a JPA `@Entity` will fail at runtime or produce undefined behavior.

**Fix:** Use standard classes for `@Entity` and `@Embeddable`. Reserve `record` for:
- DTOs/VOs returned from controllers or services
- Repository query projections
- API request/response payloads

```java
// BAD
@Entity
public record UserEntity(Long id, String name) {} // Will fail

// GOOD
public record UserDTO(String name, String email) {}
```

### Virtual Threads Do Not Improve CPU-Bound Tasks
Virtual Threads (JDK 21+) are lightweight threads managed by the JVM, but they still run on platform threads (carrier threads). For CPU-intensive work (heavy computation, complex sorting, image processing), Virtual Threads provide no throughput benefit and may add scheduling overhead. Their value is in high-concurrency I/O-bound workloads (network calls, database queries, file I/O) where millions of blocked threads can coexist without exhausting the OS thread pool.

**Fix:** Use Virtual Threads for:
- REST controllers handling many concurrent HTTP requests
- Async I/O operations (database, HTTP client, message queues)

Avoid Virtual Threads for:
- Video encoding, matrix multiplication, batch ETL transforms
- Tight loops with minimal blocking

```java
// Good use case: concurrent HTTP calls
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    var futures = urls.stream()
        .map(url -> executor.submit(() -> fetch(url)))
        .toList();
    // ...
}
```

## Step-by-Step Workflows

### Create a Complete CRUD Endpoint

Follow these steps to build a fully functional REST CRUD endpoint with Spring Boot 3, JPA, MapStruct, and validation.

**Step 1: Define the Entity**
```java
@Entity
@Table(name = "products")
public class Product {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String description;

    @Column(nullable = false)
    private BigDecimal price;

    // Getters, setters, equals, hashCode, toString
}
```

**Step 2: Create the DTOs**
```java
public record ProductRequest(
    @NotBlank String name,
    String description,
    @NotNull @Positive BigDecimal price
) {}

public record ProductResponse(Long id, String name, String description, BigDecimal price) {}
```

**Step 3: Create the Repository**
```java
@Repository
public interface ProductRepository extends JpaRepository<Product, Long> {
    boolean existsByName(String name);
}
```

**Step 4: Create the Mapper**
```java
@Mapper(componentModel = "spring")
public interface ProductMapper {
    Product toEntity(ProductRequest request);
    ProductResponse toResponse(Product entity);
}
```

**Step 5: Create the Service**
```java
@Service
@RequiredArgsConstructor
public class ProductService {
    private final ProductRepository productRepository;
    private final ProductMapper productMapper;

    @Transactional(readOnly = true)
    public List<ProductResponse> findAll() {
        return productRepository.findAll().stream()
            .map(productMapper::toResponse)
            .toList();
    }

    @Transactional(readOnly = true)
    public Optional<ProductResponse> findById(Long id) {
        return productRepository.findById(id)
            .map(productMapper::toResponse);
    }

    @Transactional
    public ProductResponse create(ProductRequest request) {
        if (productRepository.existsByName(request.name())) {
            throw new DuplicateResourceException("Product already exists");
        }
        Product product = productMapper.toEntity(request);
        return productMapper.toResponse(productRepository.save(product));
    }

    @Transactional
    public ProductResponse update(Long id, ProductRequest request) {
        Product product = productRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Product not found"));
        product.setName(request.name());
        product.setDescription(request.description());
        product.setPrice(request.price());
        return productMapper.toResponse(productRepository.save(product));
    }

    @Transactional
    public void delete(Long id) {
        if (!productRepository.existsById(id)) {
            throw new ResourceNotFoundException("Product not found");
        }
        productRepository.deleteById(id);
    }
}
```

**Step 6: Create the Controller**
```java
@RestController
@RequestMapping("/api/products")
@RequiredArgsConstructor
@Validated
public class ProductController {
    private final ProductService productService;

    @GetMapping
    public List<ProductResponse> getAll() {
        return productService.findAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<ProductResponse> getById(@PathVariable Long id) {
        return productService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<ProductResponse> create(
            @Valid @RequestBody ProductRequest request,
            UriComponentsBuilder uriBuilder) {
        ProductResponse created = productService.create(request);
        URI location = uriBuilder.path("/api/products/{id}")
            .buildAndExpand(created.id())
            .toUri();
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    public ProductResponse update(@PathVariable Long id, @Valid @RequestBody ProductRequest request) {
        return productService.update(id, request);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable Long id) {
        productService.delete(id);
    }
}
```

**Step 7: Add Global Exception Handling**
```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<ProblemDetail> handleNotFound(ResourceNotFoundException ex) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(problem);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ProblemDetail> handleValidation(MethodArgumentNotValidException ex) {
        ProblemDetail problem = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        Map<String, String> errors = ex.getBindingResult().getFieldErrors().stream()
            .collect(Collectors.toMap(FieldError::getField, FieldError::getDefaultMessage));
        problem.setProperty("errors", errors);
        return ResponseEntity.badRequest().body(problem);
    }
}
```

**Step 8: Write Integration Tests**
Use Testcontainers to test the full stack. See `assets/testcontainers-test-template.java` for a reusable template.

## Guidelines

- Prefer Records for immutable data structures (DTOs, projections, API payloads)
- Use Virtual Threads for I/O-bound tasks (JDK 21+); avoid for CPU-bound work
- Follow Clean Architecture and SOLID principles
- Use constructor injection (Lombok `@RequiredArgsConstructor` recommended)
- Use structured logging (SLF4J/Logback) with MDC for trace IDs
- Map entities to DTOs before crossing service boundaries to avoid lazy-loading leaks
- Use `ProblemDetail` (RFC 7807) for consistent API error responses
- Keep `@Transactional` methods public and non-final
- Always validate input DTOs with Bean Validation (`@Valid`)

## Resources

- **Templates:** See `assets/` for reusable code templates:
  - `rest-controller-template.java` - Production-ready REST controller skeleton
  - `testcontainers-test-template.java` - Integration test bootstrap with PostgreSQL
  - `application.yml` - Recommended Spring Boot 3 configuration
- **References:** See `references/` for detailed guides:
  - `spring-boot-design-patterns.md` - Repository, Service, Controller, and DTO mapping patterns
  - `hibernate-configuration-guide.md` - Hibernate tuning, fetch strategies, and二级缓存
