# Codex-style Plan Mode for Pi

Extensión para Pi que replica el flujo de **Plan Mode estilo Codex**:

- modo de planificación read-only (`/plan`)
- preguntas de clarificación con UI interactiva tipo tabs (`request_user_input`)
- respuestas por opción, con texto adicional sobre esa misma opción, o respuesta personalizada
- decisión final: **implementar** o **seguir refinando**

## Qué implementa

### 1) Plan Mode estilo Codex

- Comando: `/plan` (toggle)
- Shortcut: `Ctrl+Alt+P`
- En plan mode:
  - tools permitidas: `read`, `bash`, `grep`, `find`, `ls`, `request_user_input`
  - bloquea `edit` y `write`
  - bloquea comandos bash destructivos

### 2) UI tipo request_user_input

Tool: `request_user_input`

- pestañas por pregunta + pestaña final de submit
- selección con `↑/↓`, `j/k`, `1-9`, `Enter`
- navegación entre tabs con `Tab / Shift+Tab` (también `←/→`, `Ctrl+n/Ctrl+p`)
- opción extra `None of the above` para respuesta personalizada
- si empezás a escribir, ese texto se agrega como detalle de la opción seleccionada (sin obligarte a usar la última opción)
- confirmación si hay preguntas sin responder

### 3) Flujo final del plan

Cuando detecta un plan numerado (`Plan:` + pasos), muestra:

- `Yes, implement this plan`
- `No, stay in Plan mode`
- `Refine with additional feedback`

Si elegís implementar, sale de plan mode y además:

1. importa automáticamente los pasos al `todo` de tu otra extensión (vía `pi.events`)
2. envía un kickoff oculto al modelo para reforzar que use/actualice `todo` por id
3. incentiva explícitamente la búsqueda/uso de skills relevantes antes de implementar

## Instalación

Ya con estos archivos dentro de:

- `~/.pi/agent/extensions/codex-plan-mode/index.ts`

solo corré:

```bash
/reload
```

o reiniciá `pi`.

## Comandos

- `/plan` → activar/desactivar plan mode
- `/plan-status` → ver estado actual y último plan parseado

## Notas

- El estado de plan mode y el último plan se persisten en la sesión.
- La UI está inspirada en el comportamiento real del repo `openai/codex` (request_user_input + prompt de implementación de plan).
