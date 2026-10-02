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

/**
 * Stateless, sin CSRF/basic/form. Lo público sale de `${app.api.public-path}`
 * por @Value, NUNCA literal. 401/403 en application/problem+json con `type`.
 * DEC-08: NO hay `.oauth2ResourceServer(...)`. El JWT lo valida el gateway.
 *
 * Nota: incluye el matcher exacto `publicPath` ADEMÁS de `publicPath + "/**"`,
 * porque el segundo no matchea `/api/<seg>/public` sin barra final (daría 401
 * donde se espera 200). users-service aún tiene solo el segundo matcher:
 * diferencia documentada en el SPEC, no un error de este template.
 */
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain chain(HttpSecurity http, GatewayIdentityFilter identityFilter,
            @Value("${app.api.public-path}") String publicPath) throws Exception {
        return http
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(b -> b.disable())
                .formLogin(f -> f.disable())
                .addFilterBefore(identityFilter, UsernamePasswordAuthenticationFilter.class)
                .authorizeHttpRequests(a -> a
                        .requestMatchers(publicPath, publicPath + "/**").permitAll()
                        .requestMatchers("/actuator/health/**").permitAll()
                        .requestMatchers("/error").permitAll()
                        .anyRequest().authenticated())
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((request, response, ex) -> {
                            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                            response.setContentType("application/problem+json");
                            response.getWriter().write(
                                    "{\"type\":\"https://tpi.utn.frc/errors/no-autenticado\","
                                    + "\"title\":\"No autenticado\",\"status\":401,"
                                    + "\"detail\":\"El request no trae headers de identidad validados.\","
                                    + "\"instance\":\"" + request.getRequestURI() + "\"}");
                        })
                        .accessDeniedHandler((request, response, ex) -> {
                            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                            response.setContentType("application/problem+json");
                            response.getWriter().write(
                                    "{\"type\":\"https://tpi.utn.frc/errors/access-denied\","
                                    + "\"title\":\"Access denied\",\"status\":403,"
                                    + "\"detail\":\"You do not have permission for this operation.\","
                                    + "\"instance\":\"" + request.getRequestURI() + "\"}");
                        }))
                .build();
    }
}
