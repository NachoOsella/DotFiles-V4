---
name: code-refactor
description: Use for improving code structure, readability, and performance.
---

# Code Refactoring

## Common Code Smells (Summary)

| Smell | Symptom | Refactoring |
|-------|---------|-------------|
| Long method | > 20 lines, multiple responsibilities | Extract method |
| Deep nesting | > 3 levels of indentation | Early returns, extract method |
| Duplicated code | Same logic in multiple places | Extract to shared function |
| Large class | Too many responsibilities | Split into focused classes |
| Primitive obsession | Raw types instead of domain objects | Create value objects |
| Feature envy | Method uses another class's data heavily | Move method |

For a complete catalog of smells, symptoms, and refactorings, see [references/code-smells-catalog.md](references/code-smells-catalog.md).

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

### Introduce Parameter Object
```python
# Before
def create_invoice(customer_name, customer_email, customer_address, items, tax_rate):
    ...

# After
class Customer:
    def __init__(self, name, email, address):
        self.name = name
        self.email = email
        self.address = address

def create_invoice(customer, items, tax_rate):
    ...
```

## SOLID Principles

- **S**ingle Responsibility: One reason to change
- **O**pen/Closed: Open for extension, closed for modification
- **L**iskov Substitution: Subtypes must be substitutable
- **I**nterface Segregation: Small, focused interfaces
- **D**ependency Inversion: Depend on abstractions

## Gotchas

1. **Do not refactor without tests.** Refactoring changes structure, not behavior. Without a safety net you will introduce regressions. If coverage is missing, write tests first.

2. **Do not change public APIs in a minor refactor.** Renaming or retyping public functions, classes, or endpoints turns a refactor into a breaking change. Keep signatures stable; if you must change them, document the breakage and version accordingly.

3. **Extracting a method with 5+ parameters introduces Feature Envy.** If a new extracted method needs most of another object's data, the logic probably belongs in that other object. Move the method instead of passing a long parameter list.

4. **Do not mix refactor and feature work in one commit.** It obscures history and makes rollbacks dangerous. Commit refactoring separately.

5. **Beware of over-abstraction.** Not every `if` needs a strategy pattern. Prefer clarity over cleverness.

## Validation Loop

Run this loop after every discrete refactoring step. Do not batch multiple refactorings between test runs.

```
1. Run tests before the change (baseline must be green)
2. Apply one small refactoring
3. Run tests immediately
4. If tests fail:
   a. Determine if the failure is expected (test was too coupled to structure)
   b. If unexpected, revert the change
   c. Return to step 1 with a smaller scope
5. If tests pass, commit
6. Repeat
```

Commit after each successful iteration. Small commits make bisection and reverts trivial.

## Scripts

The `scripts/` directory contains lightweight analysis helpers. Run them before refactoring to identify hotspots.

| Script | Purpose | Usage |
|--------|---------|-------|
| `scripts/method-metrics.py` | Reports lines per method and approximate nesting depth | `python scripts/method-metrics.py <file_or_dir>` |
| `scripts/basic-duplication.py` | Detects duplicated blocks of code | `python scripts/basic-duplication.py <file_or_dir> [--min-lines N]` |

These are heuristic tools, not replacements for static-analysis suites. Use their output to prioritize what to refactor, not as absolute truth.

## Assets

| Asset | Purpose |
|-------|---------|
| `assets/refactoring-commit-template.md` | Commit message template and checklist for pure refactoring commits |

## Guidelines

- Ensure tests pass before and after refactoring
- Make small, incremental changes
- Commit after each successful refactoring step
- Measure performance before/after for optimization changes
- Prefer local changes over global rewrites
- Keep public API signatures stable unless the refactor is explicitly a breaking change
