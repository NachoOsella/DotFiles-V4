# Reporte final (emitir al terminar, ~150 palabras)

## Tabla de integración `<SERVICE_ID>`

| Item | Estado |
|---|---|
| Nombre único (`serviceId`, path `/api/<seg>`) | ✅/❌ |
| Eureka (register, no fetch, healthcheck) | ✅/❌ |
| Puertos sin colisión + `expose` sin `ports` | ✅/❌ |
| Rutas por `app.api.*` (sin literales) — bloqueante | ✅/❌ |
| Filtro identidad (no valida JWT, lee X-*) | ✅/❌ |
| `@PreAuthorize` capa 1 + regla negocio capa 2 | ✅/❌ |
| Trazabilidad (`traceId`/`requestId` en logs) | ✅/❌ |
| Ida y vuelta contra users (token `aud`) | ✅/❌ |
| Alta de scope (si emite/consume propio) | ✅/❌/N/A |

Una línea por cada ❌ con archivo:línea y cómo corregirlo.

## Avisar al equipo Gateway (Identity & Users)

- `serviceId` exacto para `GATEWAY_ALLOWLIST` + segmento esperado.
- Scopes que emite/consume (con PR a `ScopeCatalog` si son nuevos).
- `clientId` para el alta del secret.
- Red `tpi-platform` + puerto interno confirmados.
- Solo si trae onboarding propio: prefijo para `GATEWAY_ACCOUNT_EXEMPT`.
- Efecto: `GATEWAY_ALLOWLIST+=<SERVICE_ID>` y `docker compose up -d api-gateway`.
  Sin esto, Eureka registra pero el gateway responde 404 por diseño.
