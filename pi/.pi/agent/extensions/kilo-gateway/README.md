# Kilo Gateway para Pi

Esta extensión registra el provider `kilo` en Pi usando el gateway compatible con OpenRouter de Kilo.

## Qué hace

- Añade autenticación por Device Code para `/login kilo`
- Registra un catálogo inicial de modelos de respaldo
- Intenta cargar en segundo plano el catálogo completo de modelos desde Kilo
- Expone comandos útiles:
  - `/kilo-refresh` para refrescar los modelos
  - `/kilo-status` para ver el estado actual

## Variables de entorno opcionales

- `KILO_API_URL`: URL base de Kilo. Por defecto `https://api.kilo.ai`
- `KILO_API_KEY`: API key para usar como fallback si no hay OAuth
- `KILO_EDITOR_NAME`: nombre del editor que se envía en headers. Por defecto `Pi`

## Instalación

Deja `kilo-gateway.ts` en esta ruta:

- `~/.pi/agent/extensions/kilo-gateway.ts`

Si prefieres usar una carpeta, renómbralo a `~/.pi/agent/extensions/kilo-gateway/index.ts` y elimina el archivo suelto para evitar cargar la extensión dos veces.

Luego reinicia Pi o ejecuta `/reload`.
