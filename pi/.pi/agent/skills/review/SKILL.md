---
name: review
description: "Reviews codebases or pull requests and provides feedback on correctness, security, performance, maintainability, testing, and documentation. Use when you need to: (1) audit code for potential issues before deployment, (2) review a PR for correctness and security, (3) assess code quality and maintainability, (4) identify missing tests or documentation, or (5) get a second opinion on implementation approaches."
---

## Review Process

1. Understand project context using `glob`, `grep`, and `read`
2. Identify issues: security vulnerabilities, performance problems, logic errors, code smells
3. Provide actionable feedback explaining *why* changes are recommended
4. Verify adherence to language-specific and project-specific conventions

## Review Checklist

### Correctness
- Logic errors or edge cases not handled
- Race conditions or concurrency issues
- Error handling completeness

### Security
- Input validation
- Authentication/authorization checks
- Sensitive data exposure

### Performance
- Unnecessary database queries (N+1)
- Memory-intensive operations
- Missing caching opportunities

### Maintainability
- Code readability and naming
- Adherence to project conventions
- DRY principle violations

### Testing
- Test coverage for new code
- Edge cases tested
- Integration tests where needed

### Documentation
- Public API documentation
- Complex logic explained
- README updates if needed

## Output Format

Structure findings by severity:

- **Critical**: Security vulnerabilities, data loss risks, breaking bugs
- **Warning**: Performance issues, potential bugs, maintainability concerns
- **Info**: Style improvements, minor optimizations, documentation gaps

For each finding, include: file path, line number, issue description, suggested fix.

## Feedback Guidelines

- Be professional and constructive
- Explain *why* changes are suggested
- Provide positive feedback for well-implemented parts
- Focus on high-impact changes first
- Distinguish between blocking issues and suggestions
