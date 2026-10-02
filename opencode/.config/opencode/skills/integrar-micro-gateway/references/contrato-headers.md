# Contrato de headers del Gateway (qué recibe tu micro)

Ya validados por el Gateway. `IdentityPropagationFilter` **primero borra** los
5 reservados entrantes (anti-spoofing) y **después inyecta** el set real desde
el JWT. Nunca copiar un valor entrante a un header de identidad.

| Header | Cuándo | Valor |
|---|---|---|
| `X-Principal-Type` | con identidad | `user` \| `service` |
| `X-User-Id` / `X-User-Roles` | `user` | UUID / `ADMIN,PROFESSOR,STUDENT` (nombres del enum `Role`, en inglés: viajan tal cual. `GESTOR`: rol nuevo definido por el equipo Identity, pendiente de alta en `Role.java` —no usar `hasRole('GESTOR')` hasta entonces) |
| `X-Service-Id` / `X-Service-Scopes` | `service` | sub / `MS,<scope>...` (`MS`→`ROLE_MS`, resto authorities peladas) |
| `traceparent` / `X-Request-Id` | siempre | W3C `00-{traceId32}-{spanId16}-{flags}` / UUID (el gateway lo devuelve en la respuesta) |

Sin headers → ruta pública (no autentica, no falla). `Authorization` se reenvía
intacto (DEC-03); el micro NO lo valida (DEC-08). `on_behalf_of`, si existe,
queda solo en el log del gateway. Nunca loguear tokens/bodies.

Autorización (tuya, dos capas): **capa 1** `@PreAuthorize` (rol ↔ endpoint, ej.
`hasRole('MS') and hasAuthority('<seg>.<scope>')`); **capa 2** regla de negocio
en el caso de uso.

Validez: solo dentro de la red privada (sin `ports:` publicado). Con puerto
publicado, `X-User-Roles: ADMIN` inventado entra sin credenciales.
