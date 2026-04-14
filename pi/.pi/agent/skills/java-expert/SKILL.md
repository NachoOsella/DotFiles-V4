---
name: java-expert
description: "Expert Java development (JDK 17-21+) with Spring Boot 3, Hibernate, and modern JVM patterns. Use when you need to: (1) build microservices with Spring Boot, (2) implement modern Java features (Records, Virtual Threads), (3) design data layers with JPA/Hibernate, (4) secure applications with Spring Security, (5) optimize JVM performance, or (6) write integration tests with Testcontainers."
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

## Guidelines

- Prefer Records for immutable data structures
- Use Virtual Threads for I/O-bound tasks (JDK 21+)
- Follow Clean Architecture and SOLID principles
- Use structured logging (SLF4J/Logback)
