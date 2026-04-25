# Pi Local Memory

Extensión de memoria persistente local para Pi, inspirada en el modelo mental de Engram.

No usa MCP, HTTP, cloud sync ni servicios remotos. Guarda todo localmente en SQLite + FTS5 y registra herramientas `mem_*` directamente en Pi.

## Ubicación

```text
~/.pi/agent/extensions/pi-engram-memory/index.ts
```

Nota: la carpeta mantiene el nombre `pi-engram-memory`, pero el código y las variables se llaman `PI_MEMORY_*`.

Recargá Pi con:

```text
/reload
```

Requiere `sqlite3` con FTS5:

```bash
sudo pacman -S sqlite
```

## Variables de entorno

- `PI_MEMORY_DB`: ruta del DB. Default: `~/.pi/agent/memory/pi-memory.db`
- `PI_MEMORY_SQLITE_BIN`: binario sqlite. Default: `sqlite3`
- `PI_MEMORY_PROJECT`: fuerza el nombre del proyecto
- `PI_MEMORY_AUTO_RECALL=0`: desactiva recuperación automática antes de cada turno
- `PI_MEMORY_AUTO_SAVE_PROMPTS=0`: desactiva guardado automático de prompts
- `PI_MEMORY_RECALL_LIMIT`: cantidad de memorias inyectadas automáticamente. Default: `6`, máximo: `20`
- `PI_MEMORY_MAX_RECALL_CHARS`: máximo de caracteres para contexto compacto. Default: `6000`
- `PI_MEMORY_CONTEXT_LIMIT`: límite por defecto para `/memcontext`. Default: `8`
- `PI_MEMORY_MIN_PROMPT_CHARS`: longitud mínima para guardar prompts automáticamente. Default: `20`
- `PI_MEMORY_SQLITE_TIMEOUT_MS`: timeout para sqlite. Default: `8000`

## Herramientas registradas

- `mem_current_project`: muestra proyecto detectado y DB usado
- `mem_save`: guarda o actualiza una memoria durable
- `mem_search`: busca observaciones con SQLite FTS5
- `mem_search_prompts`: busca prompts guardados con SQLite FTS5
- `mem_context`: muestra contexto reciente del proyecto
- `mem_update`: actualiza una memoria por ID, incluido `tool_name`
- `mem_delete`: borra una memoria, soft-delete por defecto, reporta `not_found` si no afectó filas
- `mem_get_observation`: trae el contenido completo de una memoria
- `mem_timeline`: muestra contexto cronológico alrededor de una observación
- `mem_suggest_topic_key`: sugiere una clave estable para upserts
- `mem_save_prompt`: guarda un prompt manualmente, con `force` opcional
- `mem_session_start`: inicia una nueva sesión lógica de memoria
- `mem_session_end`: marca la sesión como terminada y redacta secretos del summary
- `mem_session_summary`: guarda resumen de sesión como session summary y observación
- `mem_capture_passive`: extrae bullets/numbered learnings y usa `topic_key` automático
- `mem_merge_projects`: merge seguro de proyectos, requiere `confirm: "MERGE"` y devuelve conteos
- `mem_stats`: estadísticas del DB
- `mem_export`: exporta memorias/prompts/sesiones a JSON
- `mem_import`: importa un JSON exportado, deduplicando observaciones y prompts

## Comandos slash

- `/mem <query>`: buscar memoria
- `/memsave título :: contenido`: guardar memoria manual
- `/memcontext`: ver contexto reciente
- `/memstats`: ver métricas
- `/memexport [path]`: exportar JSON
- `/memimport <path>`: importar JSON
- `/memsetup`: validar configuración

## TUI

- El status del footer ahora usa un indicador compacto y theme-aware: `◆ mem <project>`.
- Las herramientas `mem_*` tienen renderers propios: encabezados compactos, estado success/error, proyecto activo y preview expandible.
- Al expandir un resultado de herramienta se ve el detalle completo, pero el estado colapsado evita paredes de JSON.

## Mejoras de seguridad y calidad

- Redacción de patrones comunes de secretos antes de guardar.
- `mem_delete` ya no confirma falsamente un borrado inexistente.
- `mem_merge_projects` requiere confirmación explícita y valida proyectos fuente.
- `mem_session_end` redacta secretos del resumen.
- Auto-save de prompts saltea prompts triviales o muy cortos.
- Auto-recall ignora resultados vacíos o sin términos buscables.
- Export usa `ctx.cwd` para rutas relativas.
- El esquema incluye tabla `meta` con `schema_version`.
- Índices adicionales para búsquedas por proyecto y `updated_at`.

## Notas

- El proyecto se detecta por `PI_MEMORY_PROJECT`, luego `git remote`, luego raíz git, luego nombre del cwd.
- `topic_key` permite actualizar memorias evolucionables en vez de crear duplicados.
- Si cargás otra extensión que registre herramientas `mem_*`, evitá tener ambas activas a la vez para no duplicar nombres.
