# Spring Security Review Checklist

Use this reference when reviewing Spring Boot applications that use Spring Security.

## Configuration
- [ ] `SecurityFilterChain` bean is defined and explicitly configures authorization rules.
- [ ] Default permit-all behavior is not accidentally left in place for production.
- [ ] `csrf()` is configured correctly: disabled only for stateless token APIs with justification, enabled for session-based apps.
- [ ] `cors()` is configured explicitly rather than relying on defaults if cross-origin access is required.

## Authentication
- [ ] Passwords are hashed with a strong encoder (e.g., `BCryptPasswordEncoder`), not plaintext or MD5/SHA1.
- [ ] Session or token management is appropriate for the architecture (stateful sessions vs JWT/OAuth2).
- [ ] Login endpoints rate-limited or protected against brute force.

## Authorization
- [ ] Method-level security (`@PreAuthorize`, `@Secured`, `@RolesAllowed`) is used for service-layer methods, not just URL paths.
- [ ] Object-level authorization is enforced where users should only access their own resources.

## Secrets & Configuration
- [ ] Secrets (keys, passwords, tokens) are externalized to environment variables or a secrets manager, never hardcoded.
- [ ] `application.properties` / `application.yml` do not contain production credentials.

## Logging & Errors
- [ ] Security exceptions do not leak stack traces or internal implementation details to clients.
- [ ] Failed authentication attempts are logged for monitoring.

## Dependencies
- [ ] Spring Security and related libraries are up to date to patch known CVEs.
