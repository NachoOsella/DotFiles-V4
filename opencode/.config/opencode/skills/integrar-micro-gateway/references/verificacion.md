# Verificación del micro integrado

## Grep bloqueante (antes de compilar)

Con ripgrep (o `grep -rnE`):

```
rg -n '@\w+Mapping\((value\s*=\s*|path\s*=\s*)?"/api/' src/main
```

Cubre mappings con path directo y con atributo explícito (`value` o `path`).
Cada match es ❌: los mappings usan placeholders del tipo `${app.api.…}`,
nunca el literal con el prefijo `/api/`.

Además: `app.api.public-path` termina en `/public` y `private-path` es su
prefijo padre; `SecurityConfig` referencia `publicPath` por `@Value`, no literal.

## Compilación

`mvn -q compile` (ideal: `mvn test`).

## Ida y vuelta contra users-service

`scripts/test-ida-vuelta.sh` con `GATEWAY`, `SEG`, `CLIENT_ID`, `CLIENT_SECRET`:

| # | Paso | Esperado |
|---|---|---|
| 1 | `GET /api/<seg>/public/ping` sin token + header spoofeado `X-User-Roles: ADMIN` | 200, rol NO propagado |
| 2 | Login persona → `GET /api/<seg>/quien-soy` | 200 con `X-User-Id` |
| 3 | `POST /api/users/public/auth/token` `{client_credentials, scope, audience:<SERVICE_ID>}` | `accessToken` |
| 4 | `GET /api/<seg>/…/interno` con ese token | 200 |
| 5 | Mismo token contra otro destino (`/api/echo/interno`) | 403 `invalid-audience` |
| 6 | `GET /api/<seg>/jwks-estado` con cualquier token válido | 200 `{"resultado":"ok","keys":N,"kids":[...]}` (rev 11) |

Cada paso imprime su `X-Request-Id` (el único id de correlación que el gateway
devuelve en la respuesta; `traceparent` viaja aguas abajo y se ve en los logs
del micro, no en la respuesta). Pre-requisitos del script: micro registrado en Eureka, en allowlist del gateway
(si paso 1 da 404: pedir el alta), scope dado de alta en `ScopeCatalog` y
`clientId`/secret creado (si paso 3 da 400: pedir el alta).
