#!/usr/bin/env bash

# Return one stable Spotify field for the Hyprlock music card.
field=${1:-title}

print_metadata() {
    local value=$1
    local fallback=$2
    local maximum_length=$3

    value=${value:-$fallback}
    value=${value:0:maximum_length}
    value=${value//&/\&amp;}
    value=${value//</\&lt;}
    value=${value//>/\&gt;}
    printf '%s\n' "$value"
}

format_time() {
    local total_seconds=${1:-0}
    printf '%02d:%02d' "$((total_seconds / 60))" "$((total_seconds % 60))"
}

case "$field" in
    title)
        value=$(playerctl -p spotify metadata xesam:title 2>/dev/null || true)
        print_metadata "$value" "Nothing playing" 32
        ;;
    artist)
        value=$(playerctl -p spotify metadata xesam:artist 2>/dev/null || true)
        print_metadata "$value" "Spotify" 36
        ;;
    album)
        value=$(playerctl -p spotify metadata xesam:album 2>/dev/null || true)
        print_metadata "$value" "No album information" 36
        ;;
    status)
        status=$(playerctl -p spotify status 2>/dev/null || true)
        if [[ -n $status ]]; then
            printf '%s\n' "${status^^}"
        else
            printf 'OFFLINE\n'
        fi
        ;;
    progress)
        position_raw=$(playerctl -p spotify position 2>/dev/null || true)
        duration_microseconds=$(playerctl -p spotify metadata mpris:length 2>/dev/null || true)
        position_seconds=${position_raw%%.*}

        if [[ ! $position_seconds =~ ^[0-9]+$ || ! $duration_microseconds =~ ^[0-9]+$ ]]; then
            printf '%s\n' '--:--  ━━━━━━━━━━━━━━━━━━━━━━━━  --:--'
            exit 0
        fi

        duration_seconds=$((duration_microseconds / 1000000))
        segment_count=24
        filled_count=0
        if ((duration_seconds > 0)); then
            filled_count=$((position_seconds * segment_count / duration_seconds))
            ((filled_count > segment_count)) && filled_count=$segment_count
        fi

        filled_bar=
        empty_bar=
        for ((index = 0; index < segment_count; index++)); do
            if ((index < filled_count)); then
                filled_bar+=━
            else
                empty_bar+=━
            fi
        done

        printf '%s  <span foreground="#a9b665">%s</span><span foreground="#504945">%s</span>  %s\n' \
            "$(format_time "$position_seconds")" \
            "$filled_bar" \
            "$empty_bar" \
            "$(format_time "$duration_seconds")"
        ;;
    *)
        printf 'Unknown field\n' >&2
        exit 2
        ;;
esac
