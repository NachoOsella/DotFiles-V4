package <PAQUETE_BASE>.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * EJEMPLO de llamada micro-a-micro (adaptar y renombrar). Flujo que usa Cursos
 * para pedir el perfil a users: token de servicio vía Gateway + llamada vía
 * Gateway. Nunca directo al micro destino.
 * Requiere: `clientId`/secret dado de alta (pedirlo con la allowlist) y scope
 * en `ScopeCatalog` (si es nuevo, PR a users-service).
 */
@RestController
@RequestMapping("${app.api.private-path}/cliente")
public class ClienteUsersEjemplo {

    private static final Logger log = LoggerFactory.getLogger(ClienteUsersEjemplo.class);

    private final RestClient http;
    private final String clientId;
    private final String clientSecret;

    public ClienteUsersEjemplo(
            RestClient gatewayRestClient,   // del HttpClientConfig: baseUrl = gateway + propaga traza
            @Value("${app.client-id}") String clientId,
            @Value("${app.client-secret:}") String clientSecret) {
        this.http = gatewayRestClient;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }

    @GetMapping("/perfil/{id}")
    @PreAuthorize("isAuthenticated()")
    public Map<String, Object> perfilDeUsers(@PathVariable String id) {
        Map<String, Object> resultado = new LinkedHashMap<>();

        String token;
        try {
            // `audience` = serviceId del DESTINO y debe coincidir con el que el
            // catálogo asocia al scope (si no → 400). Un token por audience.
            token = pedirTokenDeServicio("users-service", "users.profile.read");
            resultado.put("token", "obtenido");
        } catch (Exception e) {
            log.warn("No se pudo obtener el token de servicio", e);
            resultado.put("token", "FALLO: " + e.getMessage());
            return resultado;
        }

        try {
            Object perfil = http.get()
                    .uri("/api/users/profile/{id}", id)
                    .header("Authorization", "Bearer " + token)
                    .retrieve()
                    .body(Object.class);
            resultado.put("perfil", perfil);
        } catch (Exception e) {
            log.warn("El token se emitió pero la llamada falló", e);
            resultado.put("perfil", "FALLO: " + e.getMessage());
        }
        return resultado;
    }

    protected String pedirTokenDeServicio(String audience, String scope) {
        Map<String, String> body = Map.of(
                "clientId", clientId,
                "clientSecret", clientSecret,
                "grantType", "client_credentials",
                "scope", scope,
                "audience", audience);

        @SuppressWarnings("unchecked")
        Map<String, Object> respuesta = http.post()
                .uri("/api/users/public/auth/token")
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(Map.class);

        if (respuesta == null || respuesta.get("accessToken") == null) {
            throw new IllegalStateException("La respuesta no trae accessToken");
        }
        return (String) respuesta.get("accessToken");
    }
}
