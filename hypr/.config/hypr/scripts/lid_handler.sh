#!/bin/bash

INTERNAL_MONITOR="eDP-1"

if [[ "$1" == "close" ]]; then
    # Solo deshabilitar si hay OTRO monitor conectado
    if hyprctl monitors | grep "Monitor" | grep -v "$INTERNAL_MONITOR"; then
        hyprctl keyword monitor "$INTERNAL_MONITOR, disable"
    fi
elif [[ "$1" == "open" ]]; then
    # Al abrir, siempre habilitar el interno con tu config (resolución, posición, escala)
    hyprctl keyword monitor "$INTERNAL_MONITOR, 1920x1080@60, 0x0, 1"
    hyprctl reload
fi
