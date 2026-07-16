-- Session startup commands. These replace exec-once entries from hyprland.conf.

hl.on("hyprland.start", function()
    hl.exec_cmd("pgrep -x waybar >/dev/null || waybar")
    hl.exec_cmd("dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP")
    hl.exec_cmd("pgrep -x hyprpaper >/dev/null || hyprpaper")
    hl.exec_cmd("sleep 5; pgrep -x spotify >/dev/null || spotify-launcher")
    hl.exec_cmd("sleep 10; pgrep -x keepassxc >/dev/null || keepassxc")
    hl.exec_cmd("pgrep -x hypridle >/dev/null || hypridle")
    hl.exec_cmd("wl-paste --type text --watch cliphist store")
    hl.exec_cmd("wl-paste --type image --watch cliphist store")
end)
