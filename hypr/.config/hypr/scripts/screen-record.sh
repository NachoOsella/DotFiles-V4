#!/usr/bin/env bash
set -euo pipefail

system_audio=$1
microphone=$2
mode=$3
shift 3

audio=()
if [[ $system_audio == 1 && $microphone == 1 ]]; then
    audio=(-a 'default_output|default_input')
elif [[ $system_audio == 1 ]]; then
    audio=(-a default_output)
elif [[ $microphone == 1 ]]; then
    audio=(-a default_input)
fi

capture=()
case "$mode" in
    region)
        monitor_geometry=$(hyprctl monitors -j | jq -er --arg name "$1" '.[] | select(.name == $name) | "\(.x) \(.y)"')
        read -r monitor_x monitor_y <<< "$monitor_geometry"
        printf -v geometry '%dx%d%+d%+d' "$4" "$5" "$((monitor_x + $2))" "$((monitor_y + $3))"
        capture=(-w region -region "$geometry")
        ;;
    monitor)
        capture=(-w "$1")
        ;;
    window)
        capture=(-w portal)
        ;;
    all)
        monitors=$(hyprctl monitors -j | jq -c 'sort_by(.x, .y)')
        min_height=$(jq '[.[] | if (.transform % 2) == 0 then .height else .width end] | min' <<< "$monitors")
        [[ $min_height != null ]] || exit 1
        sources=""
        x=0
        while IFS=$'\t' read -r name width height; do
            scaled_width=$((width * min_height / height))
            scaled_width=$((scaled_width - scaled_width % 2))
            [[ -z $sources ]] || sources+='|'
            sources+="$name;x=$x;width=$scaled_width;height=$min_height"
            x=$((x + scaled_width))
        done < <(jq -r '.[] | [.name, (if (.transform % 2) == 0 then .width else .height end), (if (.transform % 2) == 0 then .height else .width end)] | @tsv' <<< "$monitors")
        capture=(-w "$sources" -s "${x}x${min_height}")
        ;;
    *) exit 1 ;;
esac

directory="${XDG_VIDEOS_DIR:-$HOME/Videos}/Recordings"
mkdir -p "$directory"
file="$directory/recording-$(date +%Y%m%d-%H%M%S-%N).mkv"
printf '%s\n' "$file"
exec gpu-screen-recorder "${capture[@]}" -f 60 "${audio[@]}" -o "$file" 1>&2
