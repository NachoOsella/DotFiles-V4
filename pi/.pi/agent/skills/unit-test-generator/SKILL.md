---
name: unit-test-generator
description: "Generate comprehensive unit tests for various languages and frameworks. Use when you need to: (1) add test coverage for existing code, (2) write tests for edge cases and boundary conditions, (3) set up mocks for external dependencies, (4) implement property-based testing, or (5) identify untestable code patterns."
---

# Unit Test Generation

## Framework Detection

Check project files to identify testing stack:
- **JavaScript/TS**: Jest, Vitest, Mocha, Jasmine (`package.json`)
- **Python**: Pytest, Unittest (`pyproject.toml`, `requirements.txt`)
- **Java**: JUnit 5, Mockito (`pom.xml`, `build.gradle`)
- **Go**: `testing` package, Testify (`go.mod`)

## Test Structure

Follow **AAA (Arrange, Act, Assert)** pattern:

```javascript
test('should calculate total with discount', () => {
  // Arrange
  const cart = new Cart([{ price: 100 }, { price: 50 }]);
  
  // Act
  const total = cart.calculateTotal(0.1); // 10% discount
  
  // Assert
  expect(total).toBe(135);
});
```

## Coverage Strategy

- **Happy path**: Standard execution flows
- **Edge cases**: Nulls, empty collections, boundary values
- **Error conditions**: Invalid inputs, exceptions, timeouts
- **Mocking**: Isolate external dependencies (DB, APIs, filesystem)

## Guidelines

- Use descriptive names explaining expected behavior
- Keep tests isolated and independent
- Prioritize testing business logic and critical paths
- Use coverage reports to identify gaps

## Output

After generating tests, run them:
```bash
npm test  # or pytest, go test, mvn test
```

If tests fail, analyze output and fix immediately.
