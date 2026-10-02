#!/bin/sh
# Ida y vuelta contra users-service a través del Gateway.
# Uso: GATEWAY=http://localhost:3000 SEG=cursos CLIENT_ID=cursos-service CLIENT_SECRET=xxx \
#      SCOPE=cursos.ping.read LOGIN_TOKEN=... sh test-ida-vuelta.sh
# NUNCA imprime tokens: ni el JSON de /token ni los Authorization van al log.
# Los cuerpos intermedios viven en un directorio temporal (mktemp, umask 077)
# que se borra al salir, también con error (trap).
set -u
umask 077
TMPD="$(mktemp -d)" || { echo "FALLO: no se pudo crear temp"; exit 1; }
trap 'rm -rf "$TMPD"' EXIT INT TERM

# --- validación arriba (no dentro de subshells: en dash muere el subshell y el
# --- script seguiría con el diagnóstico equivocado).
SEG="${SEG:?falta SEG (segmento, ej. cursos)}"
CLIENT_ID="${CLIENT_ID:?falta CLIENT_ID}"
CLIENT_SECRET="${CLIENT_SECRET:?falta CLIENT_SECRET}"
GATEWAY="${GATEWAY:-http://localhost:3000}"
# El token debe apuntar al micro bajo prueba: aud = <SEG>-service y scope del
# catálogo para ese destino. Con valores de otro servicio el paso 4 daría 403
# siempre y el paso 5 no discriminaría nada.
AUD="${AUD:-$SEG-service}"
SCOPE="${SCOPE:-$SEG.ping.read}"

rid() { grep -i "^X-Request-Id:" "$1" | tr -d '\r'; }
code() { grep -i "^HTTP/" "$1" | tail -1 | awk '{print $2}'; }

echo "== [1] ping público + anti-spoofing =="
curl -s -D "$TMPD/h1" -o "$TMPD/b1" "$GATEWAY/api/$SEG/public/ping" -H "X-User-Roles: ADMIN"
C1="$(code "$TMPD/h1")"; rid "$TMPD/h1"
# Primero el status: con 404 (falta allowlist) o 503 el body no trae ADMIN y un
# chequeo ciego reportaría "OK" ante un fallo de infraestructura.
if [ "$C1" != "200" ]; then
  echo "FALLO: HTTP $C1 (¿falta el alta en la allowlist? ¿micro caído?). El anti-spoof no se pudo evaluar."
# El body trae headersRecibidos: si el gateway borró el spoof, X-User-Roles es
# null y ADMIN no aparece en ningún lado del body.
elif grep -q 'ADMIN' "$TMPD/b1"; then
  echo "FALLO: el rol spoofeado llegó al micro (el gateway no lo borró)"
else
  echo "OK: rol spoofeado no propagado"
fi

if [ -n "${LOGIN_TOKEN:-}" ]; then
  echo "== [2] quien-soy con token de persona =="
  curl -s -D "$TMPD/h2" -o "$TMPD/b2" "$GATEWAY/api/$SEG/quien-soy" -H "Authorization: Bearer $LOGIN_TOKEN"
  rid "$TMPD/h2"; head -c 400 "$TMPD/b2"; echo
else
  echo "== [2] salteado (sin LOGIN_TOKEN) =="
fi

echo "== [3] token de servicio (aud=$AUD scope=$SCOPE) =="
if ! curl -s -D "$TMPD/h3" -o "$TMPD/b3" -X POST "$GATEWAY/api/users/public/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"clientId\":\"$CLIENT_ID\",\"clientSecret\":\"$CLIENT_SECRET\",\"grantType\":\"client_credentials\",\"scope\":\"$SCOPE\",\"audience\":\"$AUD\"}"; then
  echo "FALLO: el POST al emisor no respondió"; exit 1
fi
rid "$TMPD/h3"
TOKEN=$(sed -n 's/.*"accessToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMPD/b3")
if [ -z "$TOKEN" ]; then
  echo "FALLO: sin accessToken. Causas: scope fuera de ScopeCatalog, audience que no matchea al scope, o clientId/secret no dados de alta."
  sed 's/"accessToken"[[:space:]]*:[[:space:]]*"[^"]*"/"accessToken":"[OCULTO]"/' "$TMPD/b3" | head -c 300; echo; exit 1
fi
echo "OK: token obtenido (no se muestra)"

echo "== [4] interno con token de servicio =="
CODE4=$(curl -s -D "$TMPD/h4" -o /dev/null -w "%{http_code}" "$GATEWAY/api/$SEG/interno" -H "Authorization: Bearer $TOKEN")
rid "$TMPD/h4"; echo "HTTP $CODE4 (esperado 200)"

echo "== [5] aud cruzado (mismo token contra echo) =="
CODE5=$(curl -s -D "$TMPD/h5" -o /dev/null -w "%{http_code}" "$GATEWAY/api/echo/interno" -H "Authorization: Bearer $TOKEN")
rid "$TMPD/h5"; echo "HTTP $CODE5 (esperado 403: el aud acota a un destino)"
