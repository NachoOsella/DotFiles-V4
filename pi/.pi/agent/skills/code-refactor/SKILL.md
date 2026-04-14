---
name: code-refactor
description: "Propose and apply code improvements for better maintainability and performance. Use when you need to: (1) reduce technical debt, (2) improve code readability, (3) apply design patterns, (4) optimize algorithms, (5) eliminate code duplication, or (6) prepare code for extension."
---

# Code Refactoring

## Common Code Smells

| Smell | Symptom | Refactoring |
|-------|---------|-------------|
| Long method | > 20 lines, multiple responsibilities | Extract method |
| Deep nesting | > 3 levels of indentation | Early returns, extract method |
| Duplicated code | Same logic in multiple places | Extract to shared function |
| Large class | Too many responsibilities | Split into focused classes |
| Primitive obsession | Raw types instead of domain objects | Create value objects |
| Feature envy | Method uses another class's data heavily | Move method |

## Refactoring Patterns

### Extract Method
```python
# Before
def process_order(order):
    # 50 lines of validation
    # 30 lines of calculation
    # 20 lines of notification

# After
def process_order(order):
    validate_order(order)
    total = calculate_total(order)
    notify_customer(order, total)
```

### Replace Conditional with Polymorphism
```python
# Before
def calculate_area(shape):
    if shape.type == 'circle':
        return 3.14 * shape.radius ** 2
    elif shape.type == 'rectangle':
        return shape.width * shape.height

# After
class Circle:
    def area(self):
        return 3.14 * self.radius ** 2

class Rectangle:
    def area(self):
        return self.width * self.height
```

## SOLID Principles

- **S**ingle Responsibility: One reason to change
- **O**pen/Closed: Open for extension, closed for modification
- **L**iskov Substitution: Subtypes must be substitutable
- **I**nterface Segregation: Small, focused interfaces
- **D**ependency Inversion: Depend on abstractions

## Guidelines

- Ensure tests pass before and after refactoring
- Make small, incremental changes
- Commit after each successful refactoring step
- Measure performance before/after for optimization changes
