#!/usr/bin/env bash

set -euo pipefail

ROFI_THEME="${ROFI_THEME:-${XDG_CONFIG_HOME:-$HOME/.config}/rofi/powermenu.rasi}"
SESSION_ID="${XDG_SESSION_ID:-$(loginctl | awk '/tty|pts/ {print $1; exit}') }"

LOCK='  Lock'
LOGOUT='  Logout'
SUSPEND='  Suspend'
HIBERNATE='  Hibernate'
REBOOT='  Reboot'
SHUTDOWN='  Shutdown'

run_lock() {
    if command -v betterlockscreen >/dev/null 2>&1; then
        betterlockscreen -l
    elif command -v i3lock >/dev/null 2>&1; then
        i3lock
    elif command -v loginctl >/dev/null 2>&1; then
        loginctl lock-session "$SESSION_ID"
    fi
}

run_logout() {
    if command -v i3-msg >/dev/null 2>&1; then
        i3-msg exit
    elif command -v bspc >/dev/null 2>&1; then
        bspc quit
    elif command -v hyprctl >/dev/null 2>&1; then
        hyprctl dispatch exit
    elif command -v qtile >/dev/null 2>&1; then
        qtile cmd-obj -o cmd -f shutdown
    fi
}

choice=$(printf '%s\n' "$LOCK" "$LOGOUT" "$SUSPEND" "$HIBERNATE" "$REBOOT" "$SHUTDOWN" \
    | rofi -dmenu -i -no-custom -p "" -theme "$ROFI_THEME")

case "$choice" in
    "$LOCK")
        run_lock
        ;;
    "$LOGOUT")
        run_logout
        ;;
    "$SUSPEND")
        systemctl suspend
        ;;
    "$HIBERNATE")
        systemctl hibernate
        ;;
    "$REBOOT")
        systemctl reboot
        ;;
    "$SHUTDOWN")
        systemctl poweroff
        ;;
esac
