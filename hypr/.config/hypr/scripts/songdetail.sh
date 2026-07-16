#!/usr/bin/env bash

# Return one stable Spotify field for the Hyprlock music card.
field=${1:-title}

case "$field" in
    title)
        value=$(playerctl -p spotify metadata xesam:title 2>/dev/null || true)
        printf '%.42s\n' "${value:-Nothing playing}"
        ;;
    artist)
        value=$(playerctl -p spotify metadata xesam:artist 2>/dev/null || true)
        printf '%.46s\n' "${value:-Spotify}"
        ;;
    *)
        printf 'Unknown field\n' >&2
        exit 2
        ;;
esac
