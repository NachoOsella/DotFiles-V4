if status is-interactive
    # Commands to run in interactive sessions can go here
end

starship init fish | source
zoxide init fish | source


# Environment Variables
set -x HYPRSHOT_DIR /home/nacho/Documents/imagenes/screenshots/
set -x QT_QPA_PLATFORMTHEME qt5ct
set -x MOZ_ENABLE_WAYLAND 1
set -x GTK_THEME Adwaita:dark


# Aliases
abbr fastfetch 'fastfetch --logo-padding-top 3'
abbr icat 'kitten icat'
abbr volumen 'pactl set-sink-volume @DEFAULT_SINK@'
abbr paquetes 'pacman -Q | wc -l'
abbr ya 'yazi'
abbr zathura 'setsid zathura'
abbr bateria 'cat /sys/class/power_supply/BAT0/capacity'



function ll
    lsd -l $argv
end


set -gx LS_COLORS "di=38;2;125;174;163:ex=38;2;234;105;98:ln=38;2;211;134;155:or=38;2;234;105;98:mi=38;2;234;105;98:fi=00:\
*.tar=38;2;216;166;87:*.zip=38;2;216;166;87:*.gz=38;2;216;166;87:*.bz2=38;2;216;166;87:\
*.pdf=38;2;169;182;101:*.doc=38;2;169;182;101:*.txt=38;2;169;182;101:\
*.jpg=38;2;169;182;101:*.jpeg=38;2;169;182;101:*.png=38;2;169;182;101:*.gif=38;2;169;182;101:\
*.mp4=38;2;231;138;78:*.avi=38;2;231;138;78:*.mkv=38;2;231;138;78:\
*.mp3=38;2;137;180;130:*.wav=38;2;137;180;130:\
*.py=38;2;125;174;163:*.js=38;2;125;174;163:*.rs=38;2;125;174;163:*.c=38;2;125;174;163:*.cpp=38;2;125;174;163:*.h=38;2;125;174;163"

# bun
set --export BUN_INSTALL "$HOME/.bun"
set --export PATH $BUN_INSTALL/bin $PATH

# tuitube
fish_add_path /home/nacho/.termcast/compiled/tuitube/bin

# nvim mason
fish_add_path ~/.local/share/nvim/mason/bin
