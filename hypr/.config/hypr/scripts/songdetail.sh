#!/usr/bin/env bash

# Return one Spotify field as Pango markup for the Hyprlock music line.
field=${1:-title}
players=spotifast,spotify

metadata() {
    playerctl -p "$players" metadata "$1" 2>/dev/null || true
}

escape_markup() {
    local value=$1
    value=${value//&/\&amp;}
    value=${value//</\&lt;}
    value=${value//>/\&gt;}
    printf '%s' "$value"
}

truncate_text() {
    local value=$1
    local maximum_length=$2
    if ((${#value} > maximum_length)); then
        value="${value:0:maximum_length-1}…"
    fi
    printf '%s' "$value"
}

# Print nothing unless music is playing so the lock screen stays empty.
[[ $(playerctl -p "$players" status 2>/dev/null) == Playing ]] || exit 0

case "$field" in
    title)
        value=$(metadata xesam:title)
        printf '<span foreground="#a9b665">󰓇</span>  %s\n' "$(escape_markup "$(truncate_text "$value" 40)")"
        ;;
    artist)
        value=$(metadata xesam:artist)
        printf '%s\n' "$(escape_markup "$(truncate_text "$value" 44)")"
        ;;
    *)
        printf 'Unknown field\n' >&2
        exit 2
        ;;
esac
