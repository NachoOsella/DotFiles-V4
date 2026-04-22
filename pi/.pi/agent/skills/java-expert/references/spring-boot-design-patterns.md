# Spring Boot Common Design Patterns

## Repository Pattern

The Repository pattern abstracts data access and allows the domain layer to remain persistence-agnostic. In Spring Boot, this is implemented via Spring Data JPA interfaces.

### Basic Repository
```java
@Repository
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);

    @Query("SELECT u FROM User u WHERE u.status = :status")
    List<User> findByStatus(@Param("status") UserStatus status);
}
```

### Custom Implementation
When query methods are insufficient, extend with a custom interface and implementation:

```java
public interface UserRepositoryCustom {
    List<User> findActiveUsersWithOrders();
}

public class UserRepositoryCustomImpl implements UserRepositoryCustom {
    @PersistenceContext
    private EntityManager entityManager;

    @Override
    public List<User> findActiveUsersWithOrders() {
        String jpql = "SELECT DISTINCT u FROM User u JOIN FETCH u.orders WHERE u.active = true";
        return entityManager.createQuery(jpql, User.class).getResultList();
    }
}

public interface UserRepository extends JpaRepository<User, Long>, UserRepositoryCustom {}
```

### Key Rules
- Keep repositories focused on a single aggregate root
- Avoid business logic in repositories
- Use `Optional` for single-result queries to avoid `NullPointerException`
- Prefer derived query methods for simple lookups; use `@Query` for complex joins and projections

## Service Pattern

The Service layer encapsulates business logic, transaction boundaries, and orchestration between repositories and external systems.

### Structure
```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderRepository orderRepository;
    private final InventoryClient inventoryClient;
    private final EventPublisher eventPublisher;

    @Transactional
    public Order createOrder(CreateOrderRequest request) {
        // Business validations
        if (!inventoryClient.isAvailable(request.productId(), request.quantity())) {
            throw new InsufficientStockException("Out of stock");
        }

        // Domain operation
        Order order = Order.create(request.productId(), request.quantity());
        Order saved = orderRepository.save(order);

        // Side effects
        eventPublisher.publish(new OrderCreatedEvent(saved.getId()));
        return saved;
    }
}
```

### Key Rules
- Annotate the class with `@Transactional` only when most methods need write transactions; prefer method-level annotations
- Never let entities leak outside the service layer without mapping to DTOs
- Perform all writes within a single transaction to maintain consistency
- Keep services stateless; no mutable instance variables

## Controller Pattern

Controllers handle HTTP concerns only: routing, input validation, response formatting, and HTTP status codes.

### Structure
```java
@RestController
@RequestMapping("/api/orders")
@RequiredArgsConstructor
@Validated
public class OrderController {
    private final OrderService orderService;

    @GetMapping("/{id}")
    public ResponseEntity<OrderResponse> getOrder(@PathVariable Long id) {
        return orderService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<OrderResponse> create(
            @Valid @RequestBody CreateOrderRequest request,
            UriComponentsBuilder uriBuilder) {
        OrderResponse created = orderService.create(request);
        URI location = uriBuilder.path("/api/orders/{id}")
            .buildAndExpand(created.id())
            .toUri();
        return ResponseEntity.created(location).body(created);
    }
}
```

### Key Rules
- Controllers must be thin; no business logic
- Always use constructor injection
- Return `ResponseEntity<T>` when you need to control status codes and headers
- Use `@Valid` to trigger Bean Validation before the method body executes
- Never expose JPA entities directly; always return DTOs

## DTO Mapping

DTOs decouple the internal domain model from the external API contract. MapStruct is the recommended tool for compile-time, type-safe mapping.

### Mapper Definition
```java
@Mapper(componentModel = "spring")
public interface UserMapper {
    User toEntity(UserRequest dto);
    UserResponse toDto(User entity);
    List<UserResponse> toDtoList(List<User> entities);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "createdAt", ignore = true)
    void updateEntity(@MappingTarget User entity, UserRequest dto);
}
```

### Gradle Dependency
```groovy
implementation 'org.mapstruct:mapstruct:1.5.5.Final'
annotationProcessor 'org.mapstruct:mapstruct-processor:1.5.5.Final'
```

### Manual Mapping (Fallback)
If MapStruct is unavailable, use a static factory method inside the DTO record:

```java
public record UserResponse(Long id, String name, String email) {
    public static UserResponse from(User user) {
        return new UserResponse(user.getId(), user.getName(), user.getEmail());
    }
}
```

### Key Rules
- Map inside the service layer before returning to the controller
- Never map lazily-loaded associations automatically; explicitly fetch or ignore them
- Use `@Mapping(target = ..., ignore = true)` for fields the client must not control
- Keep DTOs immutable; prefer Java Records

## Layered Architecture Summary

| Layer | Responsibility | Spring Component |
|-------|---------------|------------------|
| Controller | HTTP routing, status codes, input DTOs | `@RestController` |
| Service | Business logic, transactions | `@Service` |
| Repository | Data access, queries | `@Repository` |
| Domain/Entity | Data + behavior (rich model) | `@Entity` |
| DTO | API contract | `record` / class |
| Mapper | Entity <-> DTO conversion | `@Mapper` (MapStruct) |

## Anti-Patterns to Avoid

- **Anemic Domain Model:** Entities with only getters/setters and all logic in services
- **Transaction Script:** One giant service method handling multiple unrelated operations
- **Leaky Abstraction:** Returning `Entity` objects from controllers
- **God Repository:** A single repository performing queries for unrelated aggregates
- **Cascading Validation:** Validating the same object in controller, service, and repository
