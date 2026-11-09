#!/usr/bin/env bash

# Application launcher shared by the Hyprland bind and the Quickshell launcher button.
set -euo pipefail

exec rofi -show drun -theme "${XDG_CONFIG_HOME:-$HOME/.config}/rofi/config.rasi" "$@"
