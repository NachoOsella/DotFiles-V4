package <PAQUETE_BASE>.web;

import <PAQUETE_BASE>.job.JwksRefreshJob;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Estado del job JWKS (rev 11). Requiere autenticacion (capa 1 =
 * autenticado, sin scope MS): es observabilidad del propio micro, no un
 * endpoint de negocio. Verificacion: `GET ${app.api.private-path}/jwks-estado`
 * responde `{"resultado":"ok","keys":N,"kids":[...]}`.
 */
@RestController
public class JwksEstadoController {

    private final JwksRefreshJob job;

    public JwksEstadoController(JwksRefreshJob job) {
        this.job = job;
    }

    @GetMapping("${app.api.private-path}/jwks-estado")
    @PreAuthorize("isAuthenticated()")
    public Map<String, Object> estado() {
        JwksRefreshJob.Estado e = job.estado();
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("servicio", "<SERVICE_ID>");
        r.put("resultado", e.resultado());
        r.put("keys", e.cantidad());
        r.put("kids", e.kids());
        r.put("actualizadoEn", e.actualizadoEn());
        return r;
    }
}
