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

/**
 * DEC-08 — Este servicio NO valida el JWT. Su Authentication sale
 * EXCLUSIVAMENTE de los headers X-* que inyecta el Gateway.
 * Lo que los hace confiables es que el puerto NO se publica (sin `ports:`).
 */
@Component
public class GatewayIdentityFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest req,
                                    @NonNull HttpServletResponse res,
                                    @NonNull FilterChain chain) throws ServletException, IOException {
        String tipo = req.getHeader(IdentityHeaders.PRINCIPAL_TYPE);

        if ("user".equals(tipo)) {
            autenticar(req.getHeader(IdentityHeaders.USER_ID),
                    rolesDe(req.getHeader(IdentityHeaders.USER_ROLES)));
        } else if ("service".equals(tipo)) {
            autenticar(req.getHeader(IdentityHeaders.SERVICE_ID),
                    scopesDe(req.getHeader(IdentityHeaders.SERVICE_SCOPES)));
        }
        // Sin headers -> ruta pública. No autentica y no falla.

        chain.doFilter(req, res);
    }

    private void autenticar(String principal, List<GrantedAuthority> authorities) {
        SecurityContextHolder.getContext().setAuthentication(
                UsernamePasswordAuthenticationToken.authenticated(principal, null, authorities));
    }

    private List<GrantedAuthority> rolesDe(String header) {
        return partes(header).stream()
                .map(r -> (GrantedAuthority) new SimpleGrantedAuthority("ROLE_" + r))
                .toList();
    }

    /** DEC-05: MS es un ROL (-> ROLE_MS); los scopes son authorities peladas. */
    private List<GrantedAuthority> scopesDe(String header) {
        return partes(header).stream()
                .map(s -> (GrantedAuthority) new SimpleGrantedAuthority("MS".equals(s) ? "ROLE_MS" : s))
                .toList();
    }

    private List<String> partes(String header) {
        if (header == null || header.isBlank()) {
            return List.of();
        }
        return Arrays.stream(header.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }
}
