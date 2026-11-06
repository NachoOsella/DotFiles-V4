#!/usr/bin/env bash

# Print a stable local path for Hyprlock's reloadable album image.
cache_directory=${XDG_RUNTIME_DIR:-/tmp}/hyprlock-album-art
album_path=$cache_directory/spotify-album.png
url_path=$cache_directory/spotify-album.url
# Hyprlock cannot hide an image widget, so idle state shows a transparent pixel.
fallback_path=$HOME/.config/hypr/assets/empty.png
players=spotifast,spotify

mkdir -p "$cache_directory"

art_url=
if [[ $(playerctl -p "$players" status 2>/dev/null) == Playing ]]; then
    art_url=$(playerctl -p "$players" metadata --format '{{mpris:artUrl}}' 2>/dev/null || true)
fi

if [[ -z $art_url ]]; then
    printf '%s\n' "$fallback_path"
    exit 0
fi

case "$art_url" in
    file://*)
        local_path=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(urllib.parse.urlparse(sys.argv[1]).path))' "$art_url")
        if [[ -f $local_path ]]; then
            printf '%s\n' "$local_path"
        else
            printf '%s\n' "$fallback_path"
        fi
        ;;
    http://*|https://*)
        cached_url=
        [[ -f $url_path ]] && cached_url=$(<"$url_path")

        if [[ $cached_url != "$art_url" || ! -s $album_path ]]; then
            temporary_path=$(mktemp "$cache_directory/spotify-album.XXXXXX.png")
            if curl --fail --silent --show-error --location "$art_url" | magick - "$temporary_path" 2>/dev/null; then
                mv -f "$temporary_path" "$album_path"
                printf '%s\n' "$art_url" >"$url_path"
            else
                rm -f "$temporary_path"
            fi
        fi

        if [[ -s $album_path ]]; then
            printf '%s\n' "$album_path"
        else
            printf '%s\n' "$fallback_path"
        fi
        ;;
    *)
        if [[ -f $art_url ]]; then
            printf '%s\n' "$art_url"
        else
            printf '%s\n' "$fallback_path"
        fi
        ;;
esac
