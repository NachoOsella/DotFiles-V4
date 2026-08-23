# Spring security and application security rules

Use for authentication, authorization, Spring Security, CORS/CSRF, secrets, query
safety, deserialization, and security-sensitive code.

## Spring Security configuration

- For servlet applications, use bean-based `SecurityFilterChain` configuration and the
  current `authorizeHttpRequests` DSL. Do not introduce deprecated adapter-style
  configuration into new code.
- For bearer-token APIs, prefer Spring Security OAuth2 Resource Server to hand-written
  JWT parsing/verification. Configure issuer/JWK validation and map claims to
  authorities deliberately. Validate the expected audience when tokens can be issued
  for multiple resource servers; signature and issuer alone may not prove that the
  token was intended for this API.
- Preserve the project's authentication model. Do not replace sessions with JWTs, or
  JWTs with sessions, as an unrelated cleanup.

## Authorization

- Define public endpoints explicitly. Prefer an allowlist/default-deny mindset for
  sensitive applications.
- Authentication is not authorization. Check ownership/role/permission for the
  requested action.
- Use method security at service boundaries when it adds defense in depth or when the
  same use case has non-HTTP callers.
- Never trust a client-supplied user/account/tenant ID when the authenticated principal
  should determine it.
- Keep tenant scoping in every relevant query and write path.

## CSRF and CORS

- Keep CSRF protection for browser applications using cookie/session authentication.
- A stateless bearer-token API may disable CSRF when cookies are not used for auth;
  document that assumption.
- Configure CORS narrowly: known origins, methods, headers, and credential behavior.
- Never use wildcard origins with credentials.

## Credentials and passwords

- Use Spring Security's `PasswordEncoder` support; never store plaintext passwords.
- Do not invent password hashing or token cryptography.
- Use `SecureRandom` for security tokens/nonces.
- Never log passwords, bearer tokens, API keys, session IDs, refresh tokens, or private
  keys.
- Externalize signing/encryption keys and support rotation where requirements demand it.

## Injection and untrusted input

- Parameterize JDBC/JPA queries. Never concatenate user input into SQL/JPQL/HQL.
- Avoid shell invocation. If process execution is required, pass an argument list
  without a shell and validate values.
- Prevent path traversal by resolving against an allowed base and checking the
  normalized result. For uploads, generate storage names and do not trust client
  filenames or declared MIME types.
- Treat URLs supplied by users as SSRF risk, including redirects and DNS results that
  resolve to internal or metadata-service addresses.
- Do not evaluate SpEL, scripts, templates, or dynamic expressions from untrusted input.

## Serialization

- Do not use Java native serialization (`ObjectInputStream`) for untrusted data.
- Do not enable broad Jackson default polymorphic typing for untrusted JSON.
- Configure XML parsers safely when external XML is accepted; disable external entities
  and DTD behavior unless explicitly needed and secured.

## API errors and logs

- Return generic internal-error details to clients; keep diagnostic specifics in secure
  logs.
- Do not reveal whether sensitive account identifiers exist unless the product
  explicitly requires it.
- Prevent PII/secrets from becoming high-cardinality metric tags or trace baggage.

## Dependency/security posture

- Use Spring Boot dependency management/BOM rather than random version overrides.
- Upgrade known-vulnerable dependencies deliberately and run the relevant tests.
- Prefer maintained cryptographic/auth libraries over custom implementations.

## Check

Confirm object/tenant authorization, default route policy, CSRF/CORS assumptions, every
untrusted-input sink, and absence of secrets from outputs and telemetry.
