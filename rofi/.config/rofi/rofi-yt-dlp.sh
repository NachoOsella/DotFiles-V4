#!/usr/bin/env bash

set -euo pipefail

ROFI_YTDLP_THEME="${ROFI_YTDLP_THEME:-${XDG_CONFIG_HOME:-$HOME/.config}/rofi/yt-dlp.rasi}"
downloads_dir="${XDG_DOWNLOAD_DIR:-$HOME/Downloads}"

if ! command -v yt-dlp >/dev/null 2>&1; then
    notify-send "yt-dlp is not installed" "Install yt-dlp to download videos."
    exit 1
fi

video_url=$(rofi -dmenu -theme "$ROFI_YTDLP_THEME" -p "")
[[ -n "$video_url" ]] || exit 0

mkdir -p "$downloads_dir"
notify-send "Download started" "Saving to $downloads_dir"

(
    if yt-dlp --no-playlist --paths "$downloads_dir" \
        -o "%(title)s [%(id)s].%(ext)s" -- "$video_url"; then
        notify-send "Download complete" "Saved to $downloads_dir"
    else
        notify-send "Download failed" "Check that the link is valid and try again."
    fi
) >/dev/null 2>&1 &
