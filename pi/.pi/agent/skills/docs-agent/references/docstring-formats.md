# Docstring Format Reference

This document details the canonical docstring conventions for each supported language. Use the format that matches the project's existing conventions; default to these when no convention is established.

---

## Google Python Style

Preferred for all Python projects unless the codebase already uses NumPy or Sphinx style.

```python
def fetch_user(user_id: str, include_inactive: bool = False) -> dict:
    """Retrieve a user record by ID.

    Args:
        user_id: Unique identifier of the user. Must be a valid UUID v4.
        include_inactive: If True, include users whose status is 'inactive'.
            Defaults to False.

    Returns:
        A dictionary containing user fields: id, name, email, status.

    Raises:
        ValueError: If user_id is not a valid UUID.
        UserNotFoundError: If no user exists with the given ID.

    Example:
        >>> fetch_user("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")
        {'id': 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'name': 'Ada', ...}
    """
```

### Rules
- Summary line is a single imperative sentence, no period required but acceptable.
- Leave a blank line between the summary and the description/args.
- `Args`, `Returns`, `Raises`, `Yields`, `Example` are standard sections.
- Types go in the type annotation, not in the docstring text.

---

## JSDoc (JavaScript / TypeScript)

Preferred for JS/TS projects. Use TypeScript types in annotations when available.

```javascript
/**
 * Compute the cart total with tax and optional discount.
 *
 * @param {CartItem[]} items - Line items to include in the total.
 * @param {number} taxRate - Decimal tax rate (e.g., 0.08 for 8%).
 * @param {string} [discountCode] - Optional promotional code.
 * @returns {number} The final total in the cart's currency.
 * @throws {RangeError} If taxRate is negative or exceeds 1.
 *
 * @example
 * const total = computeTotal([{ price: 100, qty: 2 }], 0.08);
 * console.assert(total === 216);
 */
function computeTotal(items, taxRate, discountCode) {
  // ...
}
```

### Rules
- Use `@param`, `@returns` (or `@return`), `@throws` (or `@exception`).
- Bracket the name for optional parameters: `[discountCode]`.
- Include types in curly braces: `{CartItem[]}`.
- Use `@example` for runnable, copy-pasteable snippets.

---

## Javadoc (Java)

Standard for all Java projects.

```java
/**
 * Persists a payment transaction to the ledger after validating
 * idempotency constraints. Duplicate transactions within the
 * deduplication window are rejected to prevent double-spending.
 *
 * @param transaction the payment to record; must contain a non-null
 *                    idempotency key and a positive amount
 * @param windowMs    deduplication window in milliseconds
 * @return the persisted transaction with assigned ledger ID
 * @throws IllegalArgumentException if the transaction is null or invalid
 * @throws DuplicateKeyException    if an identical key exists within the window
 *
 * @see TransactionValidator
 * @since 2.4.0
 */
public Transaction recordPayment(Transaction transaction, long windowMs) {
    // ...
}
```

### Rules
- First sentence is the summary; use `<p>` to separate paragraphs if HTML is enabled.
- `@param`, `@return`, `@throws`, `@see`, `@since` are standard tags.
- Align parameter descriptions to improve readability in block format.
- Document thread-safety expectations if the class or method is not thread-safe.

---

## Rust Documentation Comments

Standard for all Rust projects. Uses Markdown inside `///` or `//!`.

```rust
/// Attempts to reserve capacity for at least `additional` more elements.
///
/// # Panics
///
/// Panics if the new capacity exceeds `isize::MAX` bytes.
///
/// # Errors
///
/// Returns `Err(CapacityError)` if the allocator reports failure.
///
/// # Examples
///
/// ```
/// let mut vec = Vec::with_capacity(10);
/// vec.try_reserve(10)?;
/// assert!(vec.capacity() >= 20);
/// # Ok::<(), std::collections::TryReserveError>(())
/// ```
pub fn try_reserve(&mut self, additional: usize) -> Result<(), TryReserveError> {
    // ...
}
```

### Rules
- `///` for item-level docs; `//!` for module/crate-level docs.
- Common headings: `# Examples`, `# Panics`, `# Errors`, `# Safety`, `# See Also`.
- Code blocks inside doc comments are doctests and must compile.
- Use backticks for inline code and references to types/functions.
