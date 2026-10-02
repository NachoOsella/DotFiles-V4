package <PAQUETE_BASE>.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * Cliente hacia el Gateway. Spring Boot 4 NO auto-configura un
 * RestClient.Builder por el solo hecho de tener starter-web en el classpath,
 * asi que se declara (rev 11: sin este bean el contexto NO levanta —
 * UnsatisfiedDependencyException en cada cliente).
 *
 * Se deja SIN baseUrl a proposito: la URL la fija quien lo usa, y en este
 * servicio es SIEMPRE la del Gateway (R2). Un builder con baseUrl compartida
 * invita a que alguien lo reuse apuntando directo a otro micro, que es
 * exactamente lo que no se puede hacer.
 *
 * Ademas propaga la traza: copia `traceparent` y `X-Request-Id` del request
 * entrante al saliente. Sin esto el gateway genera una traza nueva
 * (CorrelationIdFilter) y la correlacion se corta justo en el salto entre
 * micros, que es donde mas sirve.
 */
@Configuration
public class HttpClientConfig {

    @Bean
    RestClient.Builder restClientBuilder() {
        return RestClient.builder();
    }

    @Bean
    RestClient gatewayRestClient(RestClient.Builder builder,
            @Value("${app.gateway-url:http://api-gateway:8080}") String gatewayUrl) {
        return builder
                .baseUrl(gatewayUrl)
                .requestInterceptor((request, body, execution) -> {
                    HttpServletRequest entrante = requestEntrante();
                    if (entrante != null) {
                        copiar(entrante, request, "traceparent");
                        copiar(entrante, request, IdentityHeaders.REQUEST_ID);
                    }
                    return execution.execute(request, body);
                })
                .build();
    }

    private HttpServletRequest requestEntrante() {
        var attrs = RequestContextHolder.getRequestAttributes();
        return attrs instanceof ServletRequestAttributes sra ? sra.getRequest() : null;
    }

    private void copiar(HttpServletRequest entrante,
            org.springframework.http.HttpRequest saliente, String header) {
        String valor = entrante.getHeader(header);
        if (valor != null && !valor.isBlank()) {
            saliente.getHeaders().set(header, valor);
        }
    }
}
