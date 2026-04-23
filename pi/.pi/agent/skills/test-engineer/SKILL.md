---
name: test-engineer
description: Use for generating, running, and debugging tests.
---

# Test Engineer Skill

This skill combines two complementary testing approaches:
- **Unit Test Generation** (`unit-test-generator`): Creates new test files following AAA pattern
- **Test Agent** (`test-agent`): Executes, debugs, and verifies existing test suites

## When to Use

Use this skill for any testing task involving:
- Creating test files from scratch
- Adding tests to increase coverage
- Running test suites and interpreting results
- Fixing broken tests
- Verifying test reliability and maintainability

## Progressive Disclosure

### 1. Quick Start (Most Common Tasks)

#### Generate Tests for a File
```
1. Identify target file (e.g., src/auth.service.ts)
2. Determine test framework from project config
3. Create test file in appropriate location:
   - JavaScript/TypeScript: __tests__/ or tests/ or alongside source
   - Python: tests/ directory
   - Java: src/test/ directory
   - Go: _test.go file in same package
4. Write tests using AAA pattern and framework-specific syntax
```

#### Execute and Verify Tests
```
1. Run appropriate test command:
   - npm test / yarn test (Jest/Vitest)
   - pytest (Python)
   - mvn test / gradle test (Java)
   - go test ./... (Go)
2. Check output for failures
3. If tests pass: task complete
4. If tests fail: proceed to debugging
```

### 2. Detailed Workflows

#### A. Test Generation Process (unit-test-generator)

1. **Framework Detection**
   - JavaScript/TS: Check package.json for Jest, Vitest, Mocha, Jasmine
   - Python: Check pyproject.toml/requirements.txt for Pytest/Unittest
   - Java: Check pom.xml/build.gradle for JUnit 5/Mockito
   - Go: Check go.mod for testing package/Testify

2. **Test Structure (AAA Pattern)**
   ```
   test('description', () => {
     // Arrange: Set up preconditions and inputs
     // Act: Execute the function/method under test
     // Assert: Verify expected outcomes
   })
   ```

3. **Coverage Strategy**
   - Happy path: Standard execution flows
   - Edge cases: Nulls, empty collections, boundary values, invalid formats
   - Error conditions: Exception handling, timeout scenarios
   - Mocking: Isolate external dependencies (DB, APIs, filesystem)

4. **Naming Conventions**
   - Match source file: `auth.service.ts` → `auth.service.spec.ts` or `auth.service.test.ts`
   - Describe behavior: `shouldReturnValidTokenWhenCredentialsAreCorrect`

#### B. Test Execution & Debugging (test-agent)

1. **Running Tests**
   - Execute with appropriate command based on framework
   - Capture output and exit code
   - Generate coverage reports when available

2. **Analyzing Failures**
   - Read error stacks and failure messages
   - Identify root cause: assertion failure, timeout, setup issue
   - Check if failure is in test code or production code

3. **Debugging Process**
   - Isolate failing test: run single test (`npm test -- --testNamePattern="test description"`)
   - Add logging or use debugger to inspect state
   - Fix either test code (if flawed) or production code (if buggy)
   - Re-run to confirm fix

4. **Verification**
   - Ensure all tests pass after changes
   - Verify coverage didn't decrease
   - Check for flaky tests (non-deterministic passes/fails)

### 3. Common Gotchas (see references/gotchas.md for details)

- **Test Order Dependency**: Tests must be independent; never rely on state from previous tests
- **Over-Mocking**: Mocks should verify contracts, not inspect internal implementation
- **Flaky Timers**: Avoid `setTimeout/sleep` in tests; use fake timers or async utilities
- **Hardcoded Values**: Use factories/builders for test data instead of literals
- **Testing Implementation**: Focus on behavior, not internal methods or private state

### 4. Test Runner Scripts (see scripts/)

- `run-tests.sh`: Universal test runner that:
  - Detects project type and framework
  - Executes appropriate test command
  - Parses coverage output and generates summary
  - Returns proper exit codes
- `debug-test.sh`: Helper for running single tests with verbose output
- `update-snapshots.sh`: For frameworks with snapshot testing (Jest, Vitest)

### 5. Asset Templates (see assets/templates/)

Pre-written test templates for quick starts:
- `jest-template.js`: Jest test with AAA pattern
- `pytest-template.py`: Pytest test with fixtures
- `junit-template.java`: JUnit 5 test with Mockito
- `go-template.go`: Go test with table-driven tests

Each template includes:
- Proper imports/setup
- AAA-commented structure
- Placeholder for arrange/act/assert
- Common mocking patterns

### 6. Reference Documentation

Detailed information is available in the references/ directory:
- `references/gotchas.md`: Comprehensive list of testing pitfalls
- `references/framework-specific.md`: Framework-specific tips and tricks
- `references/coverage-interpretation.md": How to read and act on coverage reports
- `references/mocking-best-practices.md": When and how to mock effectively

## Output Expectations

When using this skill, you should expect:
1. **For test generation**: New test files in correct location with compilable/runnable tests
2. **For test execution**: Clear pass/fail status with actionable failure information
3. **For debugging**: Fixed tests and/or production code with verification steps
4. **For coverage**: Increased or maintained coverage percentage with gap analysis

## Best Practices

- Always run existing tests before adding new ones to ensure clean baseline
- Write tests that fail initially (RED) then make them pass (GREEN) - TDD approach
- Keep tests fast: avoid I/O, sleeps, and external dependencies in unit tests
- Test one thing per test: single assertion concept per test (though multiple asserts OK if testing same concept)
- Treat test code as production code: same quality standards apply