#!/usr/bin/env bash

# Download a video or its audio with yt-dlp, then copy the file to the clipboard.
set -euo pipefail

theme="${ROFI_YTDLP_THEME:-${XDG_CONFIG_HOME:-$HOME/.config}/rofi/yt-dlp.rasi}"
downloads_dir="${XDG_DOWNLOAD_DIR:-$HOME/Downloads}"

for command in yt-dlp rofi wl-copy; do
    if ! command -v "$command" >/dev/null 2>&1; then
        notify-send -a yt-dlp "Download unavailable" "Missing required command: $command"
        exit 1
    fi
done

# Offer a link already in the clipboard as the first choice.
clipboard=$(wl-paste --no-newline --type text 2>/dev/null || true)
suggestion=
if [[ $clipboard =~ ^https?://[^[:space:]]+$ ]]; then
    suggestion=$clipboard
fi

video_url=$(printf '%s' "$suggestion" | rofi -dmenu -theme "$theme" -p "󰗃" || true)
[[ -n $video_url ]] || exit 0

format=$(printf '%s\n' "󰕧  Video" "󰎈  Audio (mp3)" \
    | rofi -dmenu -i -no-custom -theme "$theme" -p "󰗃" -format i || true)
[[ $format =~ ^[01]$ ]] || exit 0

mkdir -p "$downloads_dir"
arguments=(--no-playlist --no-simulate --paths "$downloads_dir"
    -o "%(title)s [%(id)s].%(ext)s" --print after_move:filepath)
if [[ $format == 1 ]]; then
    arguments+=(--extract-audio --audio-format mp3)
fi

notify-send -a yt-dlp "Downloading" "$video_url"

(
    if file_path=$(yt-dlp "${arguments[@]}" -- "$video_url" 2>/dev/null | tail -n 1) && [[ -f $file_path ]]; then
        # Copy as a file URI so file managers and chat apps can paste the video itself.
        python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri())' "$file_path" \
            | wl-copy --type text/uri-list
        notify-send -a yt-dlp "Download complete" "$(basename "$file_path") copied to the clipboard"
    else
        notify-send -a yt-dlp -u critical "Download failed" "Check that the link is valid and try again."
    fi
) >/dev/null 2>&1 &
