#!/usr/bin/env bash

# Keep the laptop and external monitor layouts consistent when the lid changes.
# This script is called from Hyprland binds and intentionally avoids `hyprctl reload`
# on lid close, so Waybar, hyprpaper, and other layer clients are not restarted.

set -euo pipefail

INTERNAL_MONITOR="eDP-1"
EXTERNAL_MONITOR="HDMI-A-1"
INTERNAL_MODE="1920x1080@60"
EXTERNAL_MODE="1920x1080@75"
SCALE="1"

is_external_connected() {
    # Hyprland lists connected inactive monitors with `monitors all`.
    hyprctl monitors all | grep -q "Monitor ${EXTERNAL_MONITOR}"
}

restart_layer_clients() {
    # Some layer-shell clients do not survive output removal/addition reliably.
    # Restart them after lid topology changes so the bar and wallpaper rebind to
    # the remaining active monitor instead of disappearing.
    pkill -x waybar 2>/dev/null || true
    pkill -x hyprpaper 2>/dev/null || true
    uwsm app -- waybar >/dev/null 2>&1 &
    uwsm app -- hyprpaper >/dev/null 2>&1 &
}

move_workspace_to_monitor() {
    # Hyprland 0.55 dispatches use Lua dispatcher expressions.
    local workspace="$1"
    local monitor="$2"

    hyprctl dispatch "hl.dsp.workspace.move({ workspace = ${workspace}, monitor = \"${monitor}\" })" >/dev/null
}

move_workspace_range_to_monitor() {
    # Move a contiguous workspace range to a target monitor.
    local first_workspace="$1"
    local last_workspace="$2"
    local monitor="$3"

    for workspace in $(seq "${first_workspace}" "${last_workspace}"); do
        move_workspace_to_monitor "${workspace}" "${monitor}" || true
    done
}

close_lid() {
    # If no external monitor is connected, keep the internal panel active.
    if ! is_external_connected; then
        exit 0
    fi

    # Unify every numbered desktop before removing the internal output, so the
    # active workspace is not left attached to a disabled monitor.
    move_workspace_range_to_monitor 1 10 "${EXTERNAL_MONITOR}"

    # Hyprland 0.55 uses Lua config APIs at runtime; legacy `hyprctl keyword`
    # no longer applies monitor rules. Disable the internal panel first, then
    # move the external monitor to 0x0 to avoid monitor overlap warnings.
    hyprctl eval "hl.monitor({ output = \"${INTERNAL_MONITOR}\", disabled = true })" >/dev/null
    hyprctl eval "hl.monitor({ output = \"${EXTERNAL_MONITOR}\", mode = \"${EXTERNAL_MODE}\", position = \"0x0\", scale = ${SCALE} })" >/dev/null
    restart_layer_clients
}

open_lid() {
    # Move the external monitor away from 0x0 before reloading the Lua config.
    # The reload reliably re-enables the internal panel through hypr/monitors.lua
    # without Hyprland seeing both outputs at the same coordinates.
    if is_external_connected; then
        hyprctl eval "hl.monitor({ output = \"${EXTERNAL_MONITOR}\", mode = \"${EXTERNAL_MODE}\", position = \"1920x0\", scale = ${SCALE} })" >/dev/null
        hyprctl reload >/dev/null
        move_workspace_range_to_monitor 1 5 "${EXTERNAL_MONITOR}"
    else
        hyprctl reload >/dev/null
    fi

    # Restore the split desktop layout used while the laptop is open. Do not
    # restart Waybar or hyprpaper here; matching the old behavior keeps opening
    # the lid visually stable while the reload re-enables the internal panel.
    move_workspace_range_to_monitor 6 10 "${INTERNAL_MONITOR}"
}

case "${1:-}" in
    close)
        close_lid
        ;;
    open)
        open_lid
        ;;
    *)
        echo "Usage: $0 {close|open}" >&2
        exit 2
        ;;
esac
