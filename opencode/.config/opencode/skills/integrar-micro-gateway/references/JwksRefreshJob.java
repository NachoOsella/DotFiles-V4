package <PAQUETE_BASE>.job;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Job del well-known (JWKS) — opcional pero recomendado (rev 11).
 *
 * Proposito: demostrar que el micro resuelve el `.well-known/jwks.json` de
 * users-service y detectar rotacion de `kid` sin validar JWT local (DEC-08:
 * eso lo hace el gateway). Si el `kid` activo cambia y este job no lo ve, el
 * gateway tampoco lo vera: es el canario de la cadena de firma.
 *
 * Excepcion documentada a R2: esta lectura es bootstrap de infraestructura
 * (claves publicas), NO una llamada de negocio, por eso va DIRECTO a
 * `app.jwks-url` y no por el gateway. Todo lo demas sigue pasando por
 * `GATEWAY_URL` sin excepcion.
 *
 * Requiere `@EnableScheduling` en la clase `*Application`. Nunca loguea
 * claves ni tokens: solo cantidad de keys y lista de kids.
 */
@Component
public class JwksRefreshJob {

    private static final Logger log = LoggerFactory.getLogger(JwksRefreshJob.class);

    private final RestClient http;
    private final String jwksUrl;
    private final AtomicReference<Estado> estado =
            new AtomicReference<>(new Estado("nunca", 0, List.of(), null));

    public JwksRefreshJob(RestClient.Builder builder,
            @Value("${app.jwks-url:http://users-service:8082/.well-known/jwks.json}") String jwksUrl) {
        this.http = builder.build();
        this.jwksUrl = jwksUrl;
    }

    @Scheduled(fixedDelayString = "${app.jwks-refresh-ms:300000}")
    public void refrescar() {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> jwks = http.get().uri(jwksUrl).retrieve().body(Map.class);
            List<?> keys = jwks == null ? List.of() : (List<?>) jwks.getOrDefault("keys", List.of());
            List<String> kids = keys.stream()
                    .filter(Map.class::isInstance)
                    .map(m -> String.valueOf(((Map<?, ?>) m).get("kid")))
                    .sorted().toList();
            estado.set(new Estado("ok", keys.size(), kids, Instant.now().toString()));
            log.info("JWKS ok keys={} kids={}", keys.size(), kids);
        } catch (Exception e) {
            log.warn("JWKS fallo url={}", jwksUrl, e);
            Estado anterior = estado.get();
            estado.set(new Estado("fallo: " + e.getMessage(), anterior.cantidad(),
                    anterior.kids(), anterior.actualizadoEn()));
        }
    }

    public Estado estado() {
        return estado.get();
    }

    public record Estado(String resultado, int cantidad, List<String> kids, String actualizadoEn) {
    }
}
