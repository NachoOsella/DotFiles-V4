#!/bin/bash

INTERNAL_MONITOR="eDP-1"

if [[ "$1" == "close" ]]; then
    # Disable only if ANOTHER monitor is connected
    if hyprctl monitors | grep "Monitor" | grep -v "$INTERNAL_MONITOR"; then
        hyprctl keyword monitor "$INTERNAL_MONITOR, disable"
    fi
elif [[ "$1" == "open" ]]; then
    # On open, always enable the internal display with your config (resolution, position, scale)
    hyprctl keyword monitor "$INTERNAL_MONITOR, 1920x1080@60, 0x0, 1"
    hyprctl reload
fi
