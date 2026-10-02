---
name: integrar-micro-gateway
description: Integra un microservicio Spring Boot MVC al api-gateway del Topic 01 (Eureka, rutas app.api.*, identidad propagada, trazabilidad, micro-a-micro con JWT) con flujo interactivo y verificación ida-y-vuelta contra users-service.
---

# Integrar microservicio al API Gateway

Documento y foto: `spec-integracion-micro-gateway.md` (suelto, junto a la carpeta
de esta skill) y `SPEC.md` (foto empaquetada para que la skill viaje sola).
Regla de precedencia (idéntica en ambos archivos): **gana la rev más alta de
la línea `Versión:`, sea cual sea el archivo**; el de rev menor se refresca
desde el mayor, en el sentido que corresponda:
`Copy-Item -LiteralPath ".\spec-integracion-micro-gateway.md" -Destination ".\integrar-micro-gateway\SPEC.md" -Force`
o el inverso. Sin línea `Versión:` vale como rev 0. Prohibido asumir la
dirección por el nombre del archivo. Lo que sigue es el procedimiento ejecutable.

> Alcance: **solo stack MVC** (`spring-boot-starter-web`). Si el `pom.xml` trae
> `spring-boot-starter-webflux`, detenerse y avisar: los filtros reactivos
> (`WebFilter` + contexto Reactor, sin `MDC`) no están cubiertos.

## Paso 1 — Detectar (sin preguntar)

Inspeccionar el repo destino y anotar:

1. `pom.xml` → ¿`spring-boot-starter-web` (seguir) o `spring-boot-starter-webflux`
   (detenerse)? ¿`spring-cloud-starter-netflix-eureka-client` presente?
2. Clase `*Application.java` → paquete base (destino de filtros/config).
3. `src/main/resources/application.yml` → ¿existen `spring.application.name`,
   `server.port`, bloque `eureka`, bloque `app.api`, `logging.pattern.level`?
   Respetar lo presente; solo agregar lo faltante.
4. `src/main/**/*.java` → `@RequestMapping`/`@*Mapping` con literal `"/api/`.
   Anotar archivo:línea (es ❌ salvo que se migre a `${app.api.*}`).

## Paso 2 — Preguntar (solo lo no detectado)

Usar la herramienta de preguntas. Todo con default; Enter alcanza. Ver tabla de
variables interactivas del spec (§2): `serviceId`/segmento (avisar: sin
`-service` embebido, la derivación usa `replace()` global), puertos
(management = app+1), `GATEWAY_URL`, `EUREKA_URL`, redes (¿BD propia?),
onboarding propio (¿`ACCOUNT_EXEMPT`?), `clientId`/secret, scopes (si no están
en `ScopeCatalog`, hay que darlos de alta — no seguir de largo).
Mostrar los valores resueltos antes de escribir.

## Paso 3 — Generar

Copiar de `references/` reemplazando `<SERVICE_ID>`, `<SEGMENTO>`, `<SCOPE>`
(scope del catálogo, ej. `cursos.ping.read`), `<PAQUETE_BASE>`, `<PUERTO_APP>`,
`<PUERTO_MGMT>`:

| Plantilla | Destino |
|---|---|
| `application.yml` | fusionar en `src/main/resources/application.yml` |
| `IdentityHeaders.java` | `<paquete>/config/` (si no existe) |
| `GatewayIdentityFilter.java` | `<paquete>/config/` |
| `SecurityConfig.java` | `<paquete>/config/` |
| `RequestLogFilter.java` | `<paquete>/web/` (o `shared/web/`) |
| `HttpClientConfig.java` | `<paquete>/config/` |
| `ClienteUsersEjemplo.java` | `<paquete>/web/` (adaptar y renombrar) |
| `JwksRefreshJob.java` | `<paquete>/job/` (requiere `@EnableScheduling` en `*Application`) |
| `JwksEstadoController.java` | `<paquete>/web/` |
| `EjemploController.java` | `<paquete>/web/` (adaptar y renombrar) |
| `compose-snippet.yml` | compose del equipo (+ bloque `networks: external`) |
| `pom-snippet.xml` | `pom.xml` (Eureka + actuator + `-parameters`) |

Reglas duras: sin `ports:` (solo `expose:`), `fetch-registry: false`, sin
validar JWT en el micro, mappings solo con `${app.api.*}`, micro-a-micro solo
vía `GATEWAY_URL`, `audience` = destino del catálogo, nunca loguear tokens.

## Paso 4 — Verificar

1. Grep bloqueante en `src/main`: `@*Mapping("/api/` literal → cada match ❌.
2. `public-path` termina en `/public`, `private-path` es su prefijo padre.
3. `SecurityConfig` usa `@Value`, no literal.
4. `mvn -q compile` (o `mvn test`).
5. `scripts/test-ida-vuelta.sh` (criterios en `references/verificacion.md`).

## Paso 5 — Reporte

Emitir según `references/reporte.md`: tabla ✅/❌ (~150 palabras) + bloque
"Avisar al equipo Gateway" (allowlist, scopes con PR a `ScopeCatalog` si son
nuevos, `clientId`, red+puerto, `ACCOUNT_EXEMPT` si hay onboarding propio).
Guía de errores: `404` → falta allowlist · `503+Retry-After` → sin instancias ·
`401` → identidad o sesión (`session-superseded/closed`, mirar el `type`) ·
`403 invalid-audience` → `aud`≠destino.
