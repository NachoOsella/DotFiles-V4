#!/usr/bin/env bash

# Emoji picker. Rows show only the glyph; the name and keywords are hidden search metadata.
set -euo pipefail

theme="${XDG_CONFIG_HOME:-$HOME/.config}/rofi/emoji.rasi"
database=/usr/share/rofi-emoji/all_emojis.txt

if [[ ! -r $database ]]; then
    notify-send "Emoji picker unavailable" "Install rofi-emoji for the emoji database."
    exit 1
fi

# Skin tone variants are skipped so a search returns one result per emoji.
emoji=$(awk -F'\t' '$4 !~ /skin tone/ { printf "%s\0meta\x1f%s %s %s\n", $1, $4, $5, $3 }' "$database" \
    | rofi -dmenu -i -no-custom -matching normal -sort -sorting-method fzf -theme "$theme" || true)
[[ -n $emoji ]] || exit 0

printf '%s' "$emoji" | wl-copy
