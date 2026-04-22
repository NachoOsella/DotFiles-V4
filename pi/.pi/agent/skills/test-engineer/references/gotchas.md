# Testing Gotchas and Pitfalls

## 1. Test Order Dependency
**Problem**: Tests that pass in isolation but fail when run in sequence due to shared state.
**Examples**:
- Modifying global variables or singletons
- Not cleaning up after tests (files, DB records, mocks)
- Depending on test execution order for setup
**Fix**:
- Each test should set up its own preconditions
- Use `beforeEach`/`afterEach` or equivalent to reset state
- Never assume tests run in a specific order

## 2. Over-Mocking
**Problem**: Mocks that inspect internal implementation rather than behavior.
**Examples**:
- Mocking private methods
- Verifying internal call counts or arguments unnecessarily
- Creating brittle tests that break on refactoring
**Fix**:
- Mock only external dependencies (DB, APIs, filesystem)
- Verify contracts (inputs/outputs), not internal steps
- Use spies judiciously to check interaction with collaborators

## 3. Flaky Timers and Sleeps
**Problem**: Tests that use real timers or `sleep` leading to non-deterministic failures.
**Examples**:
- `setTimeout` with hardcoded delays
- `Thread.sleep` in Java tests
- Waiting for async operations without proper assertions
**Fix**:
- Use fake timers (Jest: `jest.useFakeTimers()`)
- Use async/await with proper promises
- Poll for conditions with timeouts instead of fixed sleeps

## 4. Hardcoded Test Data
**Problem**: Literals scattered throughout tests making them hard to update.
**Examples**:
- Magic numbers and strings in multiple tests
- Duplicate object literals
**Fix**:
- Use factories, builders, or fixtures
- Extract constants for repeated values
- Consider using test data generation libraries

## 5. Testing Implementation Details
**Problem**: Tests that break when internal implementation changes but behavior remains same.
**Examples**:
- Testing private methods directly
- Asserting on specific algorithm steps
- Checking internal state that's not part of contract
**Fix**:
- Test public interface only
- Focus on what the code does, not how it does it
- If you need to test private methods, consider extracting them

## 6. Non-Deterministic Tests
**Problem**: Tests that pass or fail randomly due to external factors.
**Examples**:
- Depending on current time
- Depending on random number generators
- Depending on network or external services
**Fix**:
- Mock date/time libraries
- Seed random number generators
- Use mocks/stubs for external services
- Control the environment completely

## 7. Overly Complex Tests
**Problem**: Tests that are hard to read, maintain, or understand.
**Examples**:
- Hundreds of lines of setup
- Multiple assertions testing different concepts
- Complex mock configurations
**Fix**:
- One test, one concept
- Extract setup helpers (but keep them visible)
- Use descriptive test names
- Follow AAA pattern strictly

## 8. Ignoring Test Coverage Gaps
**Problem**: Writing tests without checking what's actually covered.
**Examples**:
- Writing tests that don't increase coverage
- Missing edge cases in covered lines
**Fix**:
- Run coverage before and after writing tests
- Focus on uncovered lines, especially complex branches
- Use coverage reports to guide test creation

## 9. Testing Third-Party Code
**Problem**: Wasting time testing library or framework code instead of your own.
**Examples**:
- Asserting that a library function works
- Testing framework lifecycle methods
**Fix**:
- Only test your own code
- Assume third-party code works (or test it in integration tests)
- Focus on your integration points with third-party code

## 10. Not Cleaning Up Resources
**Problem**: Tests that leave behind files, database records, or running processes.
**Examples**:
- Creating temporary files without deletion
- Inserting test records without rollback
- Starting servers or threads that aren't stopped
**Fix**:
- Use `afterEach` or equivalent for cleanup
- Use temporary directories that auto-clean
- Use transactions with rollback for DB tests
- Ensure all resources are released in finally blocks