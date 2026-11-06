#!/usr/bin/env bash
set -euo pipefail

directory="${HYPRSHOT_DIR:-${XDG_PICTURES_DIR:-$HOME/Pictures}}"
mkdir -p "$directory"
file="$directory/screenshot-$(date +%Y%m%d-%H%M%S-%N).png"

capture_displays() (
    local temp_dir monitor height min_height=0 image
    local -a monitors images=()
    temp_dir=$(mktemp -d)
    trap 'rm -rf "$temp_dir"' EXIT

    mapfile -t monitors < <(hyprctl monitors -j | jq -r 'sort_by(.x, .y) | .[].name')
    (( ${#monitors[@]} > 0 )) || return 1

    for monitor in "${monitors[@]}"; do
        image="$temp_dir/${#images[@]}.png"
        grim -o "$monitor" "$image" || return 1
        height=$(magick identify -format '%h' "$image") || return 1
        if (( min_height == 0 || height < min_height )); then
            min_height=$height
        fi
        images+=("$image")
    done

    magick "${images[@]}" -resize "x${min_height}" +append "$file"
)

if (( $# == 8 )) && [[ $1 == "--frozen" ]]; then
    # Crop the frame frozen by the overlay, mapping the logical selection to image pixels.
    if ! read -r image_width image_height < <(magick identify -format '%w %h\n' "$2"); then
        notify-send -u critical "Screenshot failed" "Could not read the frozen frame."
        exit 1
    fi
    crop=$(awk -v iw="$image_width" -v ih="$image_height" -v lw="$3" -v lh="$4" \
        -v x="$5" -v y="$6" -v w="$7" -v h="$8" 'BEGIN {
            sx = iw / lw
            sy = ih / lh
            cx = int(x * sx + 0.5)
            cy = int(y * sy + 0.5)
            cw = int(w * sx + 0.5)
            ch = int(h * sy + 0.5)
            if (cx + cw > iw) cw = iw - cx
            if (cy + ch > ih) ch = ih - cy
            printf "%dx%d+%d+%d", cw, ch, cx, cy
        }')
    if ! magick "$2" -crop "$crop" +repage "$file"; then
        notify-send -u critical "Screenshot failed" "Could not crop the frozen frame."
        exit 1
    fi
elif (( $# == 5 )); then
    monitor_geometry=$(hyprctl monitors -j | jq -er --arg name "$1" '.[] | select(.name == $name) | "\(.x) \(.y)"')
    read -r monitor_x monitor_y <<< "$monitor_geometry"
    if ! grim -g "$((monitor_x + $2)),$((monitor_y + $3)) ${4}x${5}" "$file"; then
        notify-send -u critical "Screenshot failed" "Could not capture the region."
        exit 1
    fi
elif (( $# == 0 )); then
    if ! capture_displays; then
        notify-send -u critical "Screenshot failed" "Could not capture the displays."
        exit 1
    fi
else
    exit 1
fi

if ! wl-copy --type image/png < "$file"; then
    notify-send -u critical "Screenshot saved" "Could not copy it to the clipboard: $file"
    exit 1
fi

notify-send -a Hyprshot -i "$file" "Screenshot saved" "Saved to $file and copied to the clipboard."
