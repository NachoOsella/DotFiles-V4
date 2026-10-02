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

/**
 * Trazabilidad lado microservicio (copia de users-service). Mete `X-Request-Id`
 * y el `traceId` del `traceparent` en el MDC; UNA línea por request.
 * Patrón alineado con el gateway: admite ':' y hasta 128 (si el filtro
 * descartara lo que el gateway propaga, la correlación se rompe en silencio).
 * Nunca bodies, tokens ni Authorization.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestLogFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(RequestLogFilter.class);

    private static final Pattern ID_VALIDO = Pattern.compile("[A-Za-z0-9._:-]{1,128}");

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
                                    FilterChain chain) throws ServletException, IOException {
        long inicio = System.nanoTime();
        putInMdc("requestId", req.getHeader(IdentityHeaders.REQUEST_ID));
        putInMdc("traceId", traceIdFrom(req.getHeader("traceparent")));
        try {
            chain.doFilter(req, res);
        } finally {
            log.info("{} {} -> {} ({} ms)", req.getMethod(), req.getRequestURI(),
                    res.getStatus(), (System.nanoTime() - inicio) / 1_000_000);
            MDC.remove("requestId");
            MDC.remove("traceId");
        }
    }

    private void putInMdc(String key, String valor) {
        if (valor != null && ID_VALIDO.matcher(valor).matches()) MDC.put(key, valor);
    }

    /** W3C: `00-{traceId 32 hex}-{spanId 16 hex}-{flags}`. */
    private String traceIdFrom(String traceparent) {
        if (traceparent == null) return null;
        String[] parts = traceparent.split("-");
        return parts.length >= 3 && parts[1].matches("[0-9a-f]{32}") ? parts[1] : null;
    }
}
