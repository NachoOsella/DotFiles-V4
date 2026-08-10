#!/usr/bin/env bash

set -euo pipefail

ROFI_CLIPHIST_THEME="${ROFI_CLIPHIST_THEME:-${XDG_CONFIG_HOME:-$HOME/.config}/rofi/cliphist.rasi}"
history_limit="${ROFI_CLIPHIST_LIMIT:-50}"
thumbnail_limit="${ROFI_CLIPHIST_THUMBNAIL_LIMIT:-8}"
cache_root="${XDG_RUNTIME_DIR:-/tmp}"
thumbnail_cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/rofi-cliphist"

for command in cliphist rofi wl-copy; do
    if ! command -v "$command" >/dev/null 2>&1; then
        notify-send "Clipboard history unavailable" "Missing required command: $command"
        exit 1
    fi
done

cache_dir=$(mktemp -d "$cache_root/rofi-cliphist.XXXXXX")
entries_file="$cache_dir/entries"
mkdir -p "$thumbnail_cache_dir"
history_ids=()
generated_thumbnails=0
trap 'rm -rf "$cache_dir"' EXIT

while IFS=$'\t' read -r entry_id preview; do
    [[ "$entry_id" =~ ^[0-9]+$ ]] || continue

    label=""
    thumbnail=""

    if [[ "$preview" =~ ^\[\[\ binary\ data\ .+\ ([[:alnum:]]+)\ ([0-9]+x[0-9]+)\ \]\]$ ]]; then
        image_format="${BASH_REMATCH[1]^^}"
        dimensions="${BASH_REMATCH[2]}"
        label="Image · $dimensions · $image_format"

        thumbnail="$thumbnail_cache_dir/$entry_id.png"
        if [[ ! -f "$thumbnail" ]] && ((generated_thumbnails < thumbnail_limit)) \
            && command -v magick >/dev/null 2>&1; then
            # Cache compact previews so later launches do not decode every image again.
            if printf '%s' "$entry_id" | cliphist decode \
                | magick - -auto-orient -thumbnail "72x54>" "$thumbnail" 2>/dev/null; then
                ((generated_thumbnails += 1))
            else
                rm -f "$thumbnail"
                thumbnail=""
            fi
        fi

        [[ -f "$thumbnail" ]] || thumbnail=""
    elif [[ "$preview" == "[[ binary data "* ]]; then
        label="Binary clipboard item"
    else
        preview=${preview//$'\r'/ }
        preview=${preview//$'\n'/ }
        label="Text · $preview"
    fi

    history_ids+=("$entry_id")
    if [[ -n "$thumbnail" ]]; then
        printf '%s\0icon\x1f%s\n' "$label" "$thumbnail" >>"$entries_file"
    else
        printf '%s\n' "$label" >>"$entries_file"
    fi
done < <(cliphist list | head -n "$history_limit")

if ((${#history_ids[@]} == 0)); then
    notify-send "Clipboard history is empty"
    exit 0
fi

selection_index=$(rofi -dmenu -i -no-custom -show-icons -format i \
    -theme "$ROFI_CLIPHIST_THEME" -p "" <"$entries_file")

[[ "$selection_index" =~ ^[0-9]+$ ]] || exit 0
selected_id="${history_ids[$selection_index]:-}"
[[ -n "$selected_id" ]] || exit 0

printf '%s' "$selected_id" | cliphist decode | wl-copy
notify-send "Clipboard restored"
