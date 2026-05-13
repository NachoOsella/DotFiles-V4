-- Session startup commands. These replace exec-once entries from hyprland.conf.

hl.on("hyprland.start", function()
    hl.exec_cmd("waybar")
    hl.exec_cmd("dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP")
    hl.exec_cmd("hyprpaper")
    hl.exec_cmd("spotify-launcher")
    hl.exec_cmd("sleep 2; keepassxc")
    hl.exec_cmd("hypridle")
    hl.exec_cmd("wl-paste --type text --watch cliphist store")
    hl.exec_cmd("wl-paste --type image --watch cliphist store")
end)
