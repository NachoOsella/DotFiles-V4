# SPEC — Integración de un microservicio Spring Boot MVC al API Gateway (Topic 01)

> Versión: 2026-09-14 rev 11. Regla de precedencia (vale en cualquier máquina,
> en cualquier dirección): entre este canónico (`spec-integracion-micro-gateway.md`)
> y la foto (`integrar-micro-gateway/SPEC.md`), **gana la rev más alta, sea cual
> sea el archivo**; el de rev menor se refresca desde el mayor. Si alguno no trae
> línea Versión, vale como rev 0. Esta regla reemplaza a cualquier "manda el
> canónico" anterior: la dirección la decide el número, no el nombre.
>
> Estado: spec para compartir con los equipos. Referencia canónica: `users-service`.
> (`echo-service` es solo un repo de prueba/dev, no parte del proyecto: sirve
> como ejemplo de micro destino, no como referencia de convenciones.)
> Convenciones base: PPTX de convenciones de integración + `SPEC-api-gateway.md` §5.1.
> Alcance: **solo stack MVC** (`spring-boot-starter-web`). Si el micro usa WebFlux,
> este spec no aplica (filtros reactivos `WebFilter` + contexto Reactor, sin `MDC`).

## 1. Relación con el PPTX de convenciones (derivas resueltas)

| # | PPTX | Estado actual (manda el código) |
|---|---|---|
| 1 | Rutas por `DiscoveryLocatorConfig` + `include-expression` (slide 6) | **Obsoleto.** Generación en Java: `AllowlistRouteLocator` + `gateway.routing.allowlist` (el SpEL no admite llamadas a método y levantaba el gateway sano con tabla vacía → 404 a todo). Alta = `GATEWAY_ALLOWLIST` + reinicio del gateway |
| 2 | `application.properties` (slides 1, 4) | Todo en `application.yml` |
| ✓ | Eureka `register:true, fetch:false, healthcheck:true`; solo gateway `fetch:true` (slide 4) | Vigente (+ `prefer-ip-address: true`) |
| ✓ | Headers X-* + `traceparent`/`X-Request-Id`, `@PreAuthorize`, `aud` acota destino (slides 7–9) | Vigente (+ `Authorization` se reenvía intacto DEC-03, `on_behalf_of` solo en log del gateway). Matiz slide 2: el gateway valida firma RS256 + `exp` + `iss` en la cadena Security; el `aud` lo valida `ServiceAudienceFilter` y **solo para tokens `type=service`** (un token de persona no lleva `aud`) |
| ✓ | Pipeline de 7 pasos (slide 9) | Deriva: el real son cadena Security (firma/exp/iss) → `SessionGuard` WebFilter `@Order(0)` (sesión única contra Redis) → GlobalFilters: Correlation(10) → Logging(20) → PublicRouteGuard(30) → PrivateRouteGuard(40) → AccountStateGuard(50) → ServiceAudienceFilter(60) → IdentityPropagation(70) → RateLimit(80) → Bulkhead(90). Ojo: `SessionGuard` corre en la cadena WebFilter, que es OTRO orden que el de los GlobalFilter. Nota de versión: revisiones nuevas del gateway agregan `InterMicroTraceFilter @Order(75)` (traza que lee dev-mailbox) entre identidad y rate-limit; si tu gateway lo tiene, incluilo en ese punto |
| ✓ | Roles en el header (slide 7: `ALUMNO,PROFESOR,ADMIN`) | Deriva: en el wire viajan los nombres del enum `Role` en inglés —`ADMIN,PROFESSOR,STUDENT` (`TokenClaims` emite con `Enum::name`, el gateway los reenvía tal cual y el micro arma `ROLE_` + valor crudo). Un `@PreAuthorize("hasRole('ALUMNO')")` da 403 permanente. Leer siempre los valores del enum, no del slide |
| ✓ | Nombres de env de cliente | Deriva: `echo-service` (repo de prueba) usa `ECHO_CLIENT_ID/SECRET`; el estándar del proyecto es `APP_CLIENT_ID/SECRET` leídos vía `app.client-id/secret` (§4). Un micro nuevo usa el estándar, no los nombres de echo |
| → | Matcher exacto de `public-path` | Deriva conocida: el template (§5b) exige `requestMatchers(publicPath, publicPath + "/**")` porque solo `+"/**"` NO matchea `/api/<seg>/public` exacto (→ 401 donde se espera 200). `users-service`/`SecurityConfig.java:37` hoy tiene solo `publicPath + "/**"`: en users, `GET /api/users/public` exacto da 401. El template es más estricto que la referencia; alinear users es un cambio de una línea pendiente |
| ✓ | `app.api.public-path/private-path` en `@RequestMapping` (slide 5) | **Obligatorio.** `users-service` ya lo cumple (7 controllers con `${app.api.*}`, bloque en `application.yml`, `@Value` en `SecurityConfig`) |

## 2. Flujo de integración (interactivo)

**Paso 1 — Detectar (sin preguntar).** Revisar el repo destino: `pom.xml`
(`starter-web` vs `webflux`, cliente Eureka, versiones Boot/Cloud), clase
`*Application.java` (paquete base), `application.yml` existente (respetar lo que
ya hay), `@RequestMapping`/`@GetMapping` con literal `"/api/` (anotar archivo:línea).

**Paso 2 — Preguntar (solo lo no detectado, todo con default):**
`serviceId` (default `<carpeta>-service`, minúsculas, termina en `-service`),
segmento = `serviceId` sin `-service` (`users-service` → `/api/users/**`, igual
que `GatewayRoutingProperties`), puerto app (siguiente par libre: `8082/8083`
users, `8084/8085` echo → `8086`; management = app+1, DEC-28),
`GATEWAY_URL` (default `http://api-gateway:8080`),
`EUREKA_URL` (default `http://eureka:8761/eureka/`), scopes que expone/consume.
Mostrar valores resueltos antes de escribir.

**Variables interactivas (todo lo que puede cambiar por equipo va como pregunta,
nada queda hardcodeado):**

| Variable | Pregunta | Default | Dónde cae |
|---|---|---|---|
| `serviceId` / segmento | ¿Nombre del servicio? | `<carpeta>-service` / sin `-service` (avisar: sin `-service` embebido, porque la derivación usa `replace()` global y `mi-service-service` da segmento `mi`) | `spring.application.name`, `app.api.*`, allowlist |
| puerto app / management | ¿Puertos? | Siguiente par libre (management = app+1) | `server.port`, `management.server.port`, `expose:`, healthcheck |
| `GATEWAY_URL` | ¿URL del gateway? | `http://api-gateway:8080` | `RestClient` micro-a-micro |
| `EUREKA_URL` | ¿URL de Eureka? | `http://eureka:8761/eureka/` | `eureka.client.service-url` |
| redes | ¿El micro tiene BD propia? | Solo `tpi-platform`; si hay BD, sumar red de datos propia (nunca `tpi-edge`, nunca la red de datos de otro equipo) | compose `networks:` |
| onboarding propio | ¿El micro trae registro/onboarding propio (cuentas no habilitadas que deban llamar fuera de users)? | No → nada; Sí → pedir `GATEWAY_ACCOUNT_EXEMPT` (ver §9, DEC-23) | aviso al equipo Gateway |
| `clientId` / secret | ¿Id del servicio como cliente? | `= serviceId`; el secret lo genera el equipo Identity & Users, viaja por variable de entorno, nunca al repo | `app.client-*`, compose `environment` |
| scopes | ¿Qué scopes emite/consume? | — (sin default: si no está en `ScopeCatalog`, hay que darlo de alta, ver §7) | `@PreAuthorize`, token |

**Paso 3 — Generar** (§4–§7). **Paso 4 — Verificar** (§8). **Paso 5 — Reporte** (§9).

## 3. Reglas duras (no negociables)

1. **El micro NO valida el JWT** (DEC-08). Su `Authentication` sale solo de los headers X-*.
2. **Sin `ports:` publicado** — solo `expose:`. Es lo que hace confiables los headers X-*.
3. **El path NO se reescribe.** El micro recibe la URL completa con prefijo.
4. **Rutas por properties** `app.api.*`, nunca literales `"/api/..."` en mappings.
5. **`fetch-registry: false`.** Solo el gateway resuelve `lb://`.
6. **Micro-a-micro siempre vía `GATEWAY_URL`** (R2), nunca directo al micro destino.
7. Token de servicio con **`audience` obligatorio** = `<destino>-service` (DEC-17),
   que debe coincidir con el destino que el catálogo asocia al scope (§7).
8. Nunca loguear bodies, tokens ni header `Authorization`.
9. Registro en Eureka ≠ exposición: fuera de la **allowlist** → 404 por diseño.

## 4. `application.yml` (fusionar, reemplazar `<...>`)

```yaml
spring:
  application:
    name: <SERVICE_ID>
server:
  port: ${SERVER_PORT:<PUERTO_APP>}
management:
  server:
    port: ${MANAGEMENT_PORT:<PUERTO_MGMT>}
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      probes:
        enabled: true
      show-details: never
eureka:
  client:
    service-url:
      defaultZone: ${EUREKA_URL:http://localhost:8761/eureka/}
    register-with-eureka: true
    fetch-registry: false
    healthcheck:
      enabled: true
  instance:
    prefer-ip-address: true
app:
  api:
    public-path: /api/<SEGMENTO>/public
    private-path: /api/<SEGMENTO>
  client-id: ${APP_CLIENT_ID:<SERVICE_ID>}  # del entorno; default = serviceId
  client-secret: ${APP_CLIENT_SECRET:}
  gateway-url: ${GATEWAY_URL:http://api-gateway:8080}  # micro-a-micro: siempre el gateway
  # JWKS (job §7b): lectura de claves PUBLICAS, bootstrap de infra — la UNICA
  # llamada que NO va por el gateway (excepcion documentada a R2).
  jwks-url: ${JWKS_URL:http://users-service:8082/.well-known/jwks.json}
  jwks-refresh-ms: ${JWKS_REFRESH_MS:300000}
logging:
  pattern:
    level: "%5p [${spring.application.name},%X{traceId:-},%X{requestId:-}]"
```

`pom.xml`: agregar `spring-boot-starter-web` + `spring-boot-starter-security`
+ `spring-cloud-starter-netflix-eureka-client` + `spring-boot-starter-actuator`
(versiones vía BOM, Boot PRIMERO). `security` es obligatoria: sin ella no
compilan `SecurityConfig` ni `GatewayIdentityFilter` (§5a/§5b). Y `-parameters`
en el `maven-compiler-plugin` (sin él, `@PathVariable` sin nombre explícito
tira 500 en runtime).

## 5. Identidad propagada (contrato de headers)

`IdentityPropagationFilter` primero **borra** los 5 reservados y después **inyecta** desde el JWT.

| Header | Cuándo | Valor |
|---|---|---|
| `X-Principal-Type` | con identidad | `user` \| `service` |
| `X-User-Id` / `X-User-Roles` | `user` | UUID / `ADMIN,PROFESSOR,STUDENT` (nombres del enum `Role`, en inglés: viajan tal cual por `Enum::name`. `GESTOR`: rol nuevo definido por el equipo Identity, pendiente de alta en `Role.java` —no usar `hasRole('GESTOR')` hasta entonces) |
| `X-Service-Id` / `X-Service-Scopes` | `service` | sub / `MS,<scope>...` (`MS`→`ROLE_MS`, resto authorities peladas) |
| `traceparent` / `X-Request-Id` | siempre | W3C Trace Context / UUID (el gateway lo devuelve en la respuesta) |

Sin headers → ruta pública (no autentica, no falla). `Authorization` se reenvía intacto.

Archivos de esta sección (en `<paquete>/config/`): `IdentityHeaders.java`
(constantes de nombres —los snippets la usan en vez de literales—),
`GatewayIdentityFilter.java`, `SecurityConfig.java`.

### 5a. `GatewayIdentityFilter.java` (`<paquete>/config/`, copia de users/echo)

```java
package <PAQUETE_BASE>.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;

@Component
public class GatewayIdentityFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest req,
            @NonNull HttpServletResponse res, @NonNull FilterChain chain)
            throws ServletException, IOException {
        String tipo = req.getHeader(IdentityHeaders.PRINCIPAL_TYPE);
        if ("user".equals(tipo)) {
            autenticar(req.getHeader(IdentityHeaders.USER_ID), rolesDe(req.getHeader(IdentityHeaders.USER_ROLES)));
        } else if ("service".equals(tipo)) {
            autenticar(req.getHeader(IdentityHeaders.SERVICE_ID), scopesDe(req.getHeader(IdentityHeaders.SERVICE_SCOPES)));
        }
        chain.doFilter(req, res);
    }
    private void autenticar(String principal, List<GrantedAuthority> a) {
        SecurityContextHolder.getContext().setAuthentication(
            UsernamePasswordAuthenticationToken.authenticated(principal, null, a));
    }
    private List<GrantedAuthority> rolesDe(String h) { // ROLE_ + cada rol
        return partes(h).stream().map(r -> (GrantedAuthority)
            new SimpleGrantedAuthority("ROLE_" + r)).toList();
    }
    private List<GrantedAuthority> scopesDe(String h) { // MS -> ROLE_MS
        return partes(h).stream().map(s -> (GrantedAuthority)
            new SimpleGrantedAuthority("MS".equals(s) ? "ROLE_MS" : s)).toList();
    }
    private List<String> partes(String h) {
        if (h == null || h.isBlank()) return List.of();
        return Arrays.stream(h.split(",")).map(String::trim)
            .filter(s -> !s.isEmpty()).toList();
    }
}
```

### 5b. `SecurityConfig.java` (stateless, 401/403 `problem+json`, sin resource server)

```java
package <PAQUETE_BASE>.config;

import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {
    @Bean
    SecurityFilterChain chain(HttpSecurity http, GatewayIdentityFilter identityFilter,
            @Value("${app.api.public-path}") String publicPath) throws Exception {
        return http
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .httpBasic(b -> b.disable()).formLogin(f -> f.disable())
            .addFilterBefore(identityFilter, UsernamePasswordAuthenticationFilter.class)
            .authorizeHttpRequests(a -> a
                .requestMatchers(publicPath, publicPath + "/**").permitAll()
                // publicPath suelto TAMBIÉN: solo +"/**" no matchea /api/<seg>/public exacto
                .requestMatchers("/actuator/health/**").permitAll()
                .requestMatchers("/error").permitAll() // dispatch ERROR sin filtro de identidad
                .anyRequest().authenticated())
            .exceptionHandling(e -> e
                .authenticationEntryPoint((rq, rs, ex) -> {
                    rs.setStatus(401); rs.setContentType("application/problem+json");
                    rs.getWriter().write("{\"type\":\"https://tpi.utn.frc/errors/no-autenticado\","
                        + "\"title\":\"No autenticado\",\"status\":401,"
                        + "\"detail\":\"El request no trae headers de identidad validados.\","
                        + "\"instance\":\"" + rq.getRequestURI() + "\"}"); })
                .accessDeniedHandler((rq, rs, ex) -> {
                    rs.setStatus(403); rs.setContentType("application/problem+json");
                    rs.getWriter().write("{\"type\":\"https://tpi.utn.frc/errors/access-denied\","
                        + "\"title\":\"Access denied\",\"status\":403,"
                        + "\"detail\":\"You do not have permission for this operation.\","
                        + "\"instance\":\"" + rq.getRequestURI() + "\"}"); }))
            .build();
    }
}
```

401 = "no sé quién sos" (al login); 403 = "sé quién sos y no podés". No mezclarlos.
Autorización en dos capas: **capa 1** `@PreAuthorize` (rol ↔ endpoint, ej.
`hasRole('MS') and hasAuthority('<SCOPE>')` —`<SCOPE>` es un scope del catálogo
(ver §7), no un nombre libre—, **capa 2** regla de negocio
en el caso de uso.

### 5c. Controladores (placeholders, nunca literales)

```java
@GetMapping("${app.api.public-path}/ping")        // sin token (prueba anti-spoofing)
@GetMapping("${app.api.private-path}/quien-soy")  // cualquier autenticado
@GetMapping("${app.api.private-path}/interno")    // + @PreAuthorize("hasRole('MS') and hasAuthority('<SCOPE>')")
@PreAuthorize("hasRole('MS') or hasRole('ADMIN')") // ejemplo endpoint compartido
```

## 6. Trazabilidad (`RequestLogFilter`, `@Order(HIGHEST_PRECEDENCE)`, copia de users)

```java
package <PAQUETE_BASE>.web;

import <PAQUETE_BASE>.config.IdentityHeaders;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.regex.Pattern;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestLogFilter extends OncePerRequestFilter {
    private static final Logger log = LoggerFactory.getLogger(RequestLogFilter.class);
    private static final Pattern ID_VALIDO = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    // Alineado con CorrelationIdFilter del gateway: admite ':' y hasta 128.
    // Un X-Request-Id que el gateway propaga pero este filtro descarta rompe
    // la correlación en silencio (línea sin traceId).
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
            FilterChain chain) throws ServletException, IOException {
        long inicio = System.nanoTime();
        putInMdc("requestId", req.getHeader(IdentityHeaders.REQUEST_ID));
        putInMdc("traceId", traceIdFrom(req.getHeader("traceparent")));
        try { chain.doFilter(req, res); }
        finally {
            log.info("{} {} -> {} ({} ms)", req.getMethod(), req.getRequestURI(),
                res.getStatus(), (System.nanoTime() - inicio) / 1_000_000);
            MDC.remove("requestId"); MDC.remove("traceId");
        }
    }
    private void putInMdc(String k, String v) {
        if (v != null && ID_VALIDO.matcher(v).matches()) MDC.put(k, v);
    }
    private String traceIdFrom(String tp) { // 00-{traceId32}-{spanId16}-{flags}
        if (tp == null) return null;
        String[] p = tp.split("-");
        return p.length >= 3 && p[1].matches("[0-9a-f]{32}") ? p[1] : null;
    }
}
```

## 7. Micro-a-micro (vía Gateway, token con `audience`)

```java
package <PAQUETE_BASE>.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@Configuration
public class HttpClientConfig {
    // Boot 4 NO auto-configura un RestClient.Builder por el solo hecho de
    // tener starter-web: se declara (rev 11: sin este bean el contexto NO
    // levanta — UnsatisfiedDependencyException en cada cliente). Se deja SIN
    // baseUrl: la fija cada cliente, y es SIEMPRE la del gateway (R2).
    @Bean
    RestClient.Builder restClientBuilder() {
        return RestClient.builder();
    }

    @Bean
    RestClient gatewayRestClient(RestClient.Builder builder,
            @Value("${app.gateway-url:http://api-gateway:8080}") String gatewayUrl) {
        return builder
                .baseUrl(gatewayUrl)
                // Propaga la traza al salto entre micros: sin esto el gateway
                // genera una traza nueva y la correlación se corta justo acá.
                .requestInterceptor((request, body, execution) -> {
                    var attrs = RequestContextHolder.getRequestAttributes();
                    if (attrs instanceof ServletRequestAttributes sra) {
                        HttpServletRequest entrante = sra.getRequest();
                        copiar(entrante, request, "traceparent");
                        copiar(entrante, request, IdentityHeaders.REQUEST_ID);
                    }
                    return execution.execute(request, body);
                })
                .build();
    }

    private void copiar(HttpServletRequest entrante,
            org.springframework.http.HttpRequest saliente, String header) {
        String valor = entrante.getHeader(header);
        if (valor != null && !valor.isBlank()) {
            saliente.getHeaders().set(header, valor);
        }
    }
}
```

```java
// Fragmento de cliente (imports: MediaType, RestClient, @Value, Map).
// http = RestClient gatewayRestClient inyectado por constructor;
// clientId/secret por properties (secret por entorno, nunca al repo,
// client-id SIN default: si falta, falla al levantar).

// 1) Pedir token. OJO: el `audience` NO es libre — se deriva del scope vía
// ScopeCatalog (users-service) y si no coincide exacto → 400
// (ServiceClientService.java:62-76). Además los scopes de distintos servicios
// en un mismo pedido → 400: un token por audience.
// Y el catálogo es CERRADO: hoy solo existe `users.profile.read` → `users-service`
// (ScopeCatalog.java:9-10). Emitir para tu micro exige ALTA DE SCOPE:
// PR a ScopeCatalog (entrada scope→serviceId) + INSERT en
// service_clients / service_client_scopes + alta del clientSecret.
// Sin eso, cualquier scope propio muere con 400 (líneas 55-59).
// Pedir el alta junto con la allowlist (§9), no después.
Map<String, String> body = Map.of("clientId", clientId, "clientSecret", clientSecret,
    "grantType", "client_credentials", "scope", "<scope-del-catalogo>",
    "audience", "<destino>-service");   // = el destino que el catálogo asocia al scope
Map<?, ?> r = http.post().uri("/api/users/public/auth/token")
    .contentType(MediaType.APPLICATION_JSON).body(body)
    .retrieve().body(Map.class);
String token = (String) r.get("accessToken");

// 2) Usarlo contra el destino por el Gateway:
http.get().uri("/api/<destino>/.../{id}", id)
    .header("Authorization", "Bearer " + token)
    .retrieve().body(Object.class);
```

Token de persona: se reenvía tal cual cuando hay una persona detrás del pedido
(no se cambia por token de servicio en medio de la cadena). `clientSecret` por
variable de entorno, nunca en el repo (pedirlo al equipo Identity & Users).

### Job del well-known (JWKS) — opcional pero recomendado (rev 11)

Demuestra que el micro resuelve el `.well-known/jwks.json` de users-service y
detecta rotación de `kid` sin validar JWT local (DEC-08: eso lo hace el
gateway). Es el canario de la cadena de firma: si este job no ve el `kid`
activo, el gateway tampoco lo verá.

Archivos: `JwksRefreshJob.java` (en `<paquete>/job/`, copia de `references/`),
`JwksEstadoController.java` (en `<paquete>/web/`), más `@EnableScheduling` en
la clase `*Application` y las claves `app.jwks-url` / `app.jwks-refresh-ms`
(§4). Verificación: `GET ${app.api.private-path}/jwks-estado` con cualquier
token válido responde `{"resultado":"ok","keys":N,"kids":[...]}`. El job
logea solo cantidad y kids — nunca claves ni tokens.

## 8. Compose + verificación

```yaml
  <SERVICE_ID>:
    build: { context: ., dockerfile: Dockerfile }
    container_name: tpi-<SEGMENTO>
    expose: ["<PUERTO_APP>", "<PUERTO_MGMT>"]   # SIN ports:
    environment:
      SERVER_PORT: "<PUERTO_APP>"
      MANAGEMENT_PORT: "<PUERTO_MGMT>"
      EUREKA_URL: http://eureka:8761/eureka/
      GATEWAY_URL: http://api-gateway:8080
      APP_CLIENT_ID: <SERVICE_ID>
      # Pass-through: el valor real viene del entorno/CI (lo genera Identity &
      # Users). Sin más indirecciones: la variable se llama igual adentro y afuera.
      APP_CLIENT_SECRET: ${APP_CLIENT_SECRET:-}
    depends_on: { eureka: { condition: service_healthy } }
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:<PUERTO_MGMT>/actuator/health/readiness | grep -q UP"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 40s
    networks: [tpi-platform]   # solo esta (+ datos propios si hay BD). Nunca tpi-edge
```

```yaml
# Al FINAL del compose del equipo (obligatorio, no opcional): sin esto compose
# crea <proyecto>_tpi-platform, una red DISTINTA — el micro arranca sano, no lo
# alcanza nadie y Eureka registra una IP inalcanzable.
networks:
  tpi-platform:
    external: true   # la crea el stack de plataforma (tpi-compose)
```

`tpi-platform` es externa (la crea el stack de plataforma). Red `tpi-edge`: solo nginx+gateway.

**Fuera de alcance:** observabilidad (Prometheus/Grafana sidecar) la cubre otra
skill; acá solo se exige exponer `health,info`. Descubrimiento: Eureka
(`register:true, fetch:false`, §4) — es lo que usa este stack.

**Script `test-ida-vuelta.sh`** (variables `GATEWAY`, `SEG`, `CLIENT_ID`, `CLIENT_SECRET`;
usa `curl -s -o /dev/null -w "%{http_code}"` y muestra el `X-Request-Id` de cada
paso —el único id que el gateway devuelve en la respuesta; `traceparent` viaja
aguas abajo y se verifica en los logs del micro, no en la respuesta—):

1. `GET $GATEWAY/api/$SEG/public/ping` sin token (+ header spoofeado `X-User-Roles: ADMIN`) → 200 y rol NO propagado.
2. Login persona en users → `GET $GATEWAY/api/$SEG/quien-soy` → 200 con `X-User-Id`.
   (Sin segmento intermedio: `private-path` es `/api/<seg>` a secas.)
3. `POST $GATEWAY/api/users/public/auth/token` `{client_credentials, scope, audience:<SERVICE_ID>}` → `accessToken`.
4. `GET $GATEWAY/api/$SEG/…/interno` con ese token → 200.
5. Mismo token contra otro destino (`/api/echo/interno`) → 403 `invalid-audience`.
6. `mvn -q compile` + grep bloqueante: ningún `@*Mapping("/api/` literal; `public-path` termina en `/public` y `private-path` es su prefijo; `SecurityConfig` usa `@Value`, no literal.

Guía de errores: `404 route-not-found` → falta allowlist · `503 + Retry-After` → sin
instancias UP · `401` → identidad **o sesión**: token firmado y vigente igual da
401 `session-superseded` (otro dispositivo logueó, single-session) o `session-closed`
(Redis, `SessionGuard`) — no reintentar login a ciegas, mirar el `type` ·
`403 invalid-audience` → `aud`≠destino.

Nota Dockerfile: el healthcheck usa `wget` — la imagen final debe traerlo
(`eclipse-temurin:21-jre-alpine` lo trae vía busybox; si cambiás de base, agregalo).

## 9. Reporte (emitir al final, ~150 palabras, tabla + avisos)

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
| Alta de scope (si emite/consume propio: `ScopeCatalog` + `service_clients`) | ✅/❌/N/A |

**Avisar al equipo Gateway** (Identity & Users, solo lo faltante): `serviceId`
exacto para `GATEWAY_ALLOWLIST`, segmento esperado, scopes que emite/consume
(con el PR a `ScopeCatalog` si son nuevos), `clientId` para el alta del secret,
confirmación de red `tpi-platform` + puerto interno, y —solo si el micro trae
onboarding propio— prefijo para `GATEWAY_ACCOUNT_EXEMPT` (DEC-23: una cuenta no
habilitada solo llega a los exempt + `public/**`; default `/api/users/**`).
Efecto: `GATEWAY_ALLOWLIST+=<SERVICE_ID>` y `docker compose up -d api-gateway`.
