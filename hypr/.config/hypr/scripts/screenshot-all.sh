#!/usr/bin/env bash
# Take a screenshot, save it, and copy it to the clipboard.
# Usage:
#   screenshot-all.sh                         all monitors side by side
#   screenshot-all.sh monitor <name>          one monitor
#   screenshot-all.sh window                  the focused window
#   screenshot-all.sh --frozen <image> [<logical_w> <logical_h> <x> <y> <w> <h>]
#                                             a frame frozen by the Quickshell overlay, optionally cropped
set -euo pipefail

directory="$HOME/Documents/imagenes/screenshots"
mkdir -p "$directory"
file="$directory/screenshot-$(date +%Y%m%d-%H%M%S-%3N).png"
# Fast zlib level: files are ~25% larger than grim's default but encode several times faster.
png_options=(-define png:compression-level=1)

fail() {
    notify-send -a Screenshot -u critical "Screenshot failed" "$1"
    exit 1
}

case "${1:-all}" in
    all)
        temp_dir=$(mktemp -d)
        trap 'rm -rf "$temp_dir"' EXIT
        mapfile -t monitors < <(hyprctl monitors -j | jq -r 'sort_by(.x, .y) | .[].name')
        (( ${#monitors[@]} > 0 )) || fail "No monitors found."
        images=()
        for monitor in "${monitors[@]}"; do
            images+=("$temp_dir/$monitor.ppm")
            grim -t ppm -o "$monitor" "${images[-1]}" &
        done
        wait || fail "Could not capture the displays."
        # Scale every monitor to the shortest height so they line up side by side.
        min_height=$(magick identify -format '%h\n' "${images[@]}" | sort -n | head -n 1)
        magick "${images[@]}" -resize "x$min_height" +append "${png_options[@]}" "$file" \
            || fail "Could not combine the displays."
        ;;
    monitor)
        grim -l 1 -o "$2" "$file" || fail "Could not capture $2."
        ;;
    window)
        geometry=$(hyprctl activewindow -j | jq -er 'select(.mapped) | "\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"') \
            || fail "No window is focused."
        grim -l 1 -g "$geometry" "$file" || fail "Could not capture the window."
        ;;
    --frozen)
        if (( $# == 2 )); then
            magick "$2" "${png_options[@]}" "$file" || fail "Could not save the frozen frame."
        elif (( $# == 8 )); then
            # Map the logical selection to pixels of the frozen frame.
            read -r image_width image_height < <(magick identify -format '%w %h\n' "$2") \
                || fail "Could not read the frozen frame."
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
            magick "$2" -crop "$crop" +repage "${png_options[@]}" "$file" || fail "Could not crop the frozen frame."
        else
            exit 2
        fi
        ;;
    *)
        exit 2
        ;;
esac

wl-copy --type image/png < "$file" || fail "Saved to $file but could not copy it to the clipboard."
# The notification is fire-and-forget so the script exits as soon as the image is on the clipboard.
notify-send -a Screenshot -i "$file" "Screenshot copied" "$(basename "$file")" &
