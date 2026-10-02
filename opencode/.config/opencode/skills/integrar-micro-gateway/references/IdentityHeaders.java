package <PAQUETE_BASE>.config;

/** Contrato de headers del Gateway, copiado tal cual. Un micro destino no inventa estos nombres: los recibe.
 * (Sin lista agregada: el micro nunca borra headers —eso lo hace el gateway—,
 * así que no hay constante colectiva que mantener.) */
public final class IdentityHeaders {

    public static final String PRINCIPAL_TYPE = "X-Principal-Type";
    public static final String USER_ID = "X-User-Id";
    public static final String USER_ROLES = "X-User-Roles";
    public static final String SERVICE_ID = "X-Service-Id";
    public static final String SERVICE_SCOPES = "X-Service-Scopes";
    public static final String REQUEST_ID = "X-Request-Id";

    private IdentityHeaders() {
    }
}
