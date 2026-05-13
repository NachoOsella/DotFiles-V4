-- GTK theme commands intentionally run on each reload, matching old exec behavior.

hl.exec_cmd("gsettings set org.gnome.desktop.interface gtk-theme Adwaita")
hl.exec_cmd("gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'")
