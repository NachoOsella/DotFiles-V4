-- Window and layer rules. Order matters: rules are evaluated top to bottom.

hl.window_rule({
    name = "suppress-maximize-events",
    match = { class = ".*" },
    suppress_event = "maximize",
})

-- Workspace assignments.
hl.window_rule({ name = "spotify-workspace", match = { class = "^(Spotify)$" }, workspace = "6" })
hl.window_rule({ name = "vesktop-workspace", match = { class = "^(vesktop)$" }, workspace = "7" })

-- KeePassXC opens centered, floating, and fixed-size on workspace 1.
hl.window_rule({
    name = "keepassxc-dialog",
    match = { class = "^(org\\.keepassxc\\.KeePassXC)$" },
    workspace = "1",
    float = true,
    size = "1100 650",
    center = true,
})

hl.window_rule({ name = "feh-float", match = { class = "^(feh)$" }, float = true })
hl.window_rule({ name = "feh-size", match = { class = "^(feh)$" }, size = "960 540" })
hl.window_rule({ name = "feh-center", match = { class = "^(feh)$" }, center = true })
hl.window_rule({ name = "vlc-float", match = { class = "^(vlc)$" }, float = true })

-- Steam window sizing.
hl.window_rule({ name = "steam-friends-size", match = { class = "steam", title = "Friends List" }, size = "30% 100%" })
hl.window_rule({ name = "steam-main-size", match = { class = "steam", title = "Steam" }, size = "70% 100%" })

-- Disable animations for screenshot and selection layers.
hl.layer_rule({ name = "hyprpicker-no-animation", match = { namespace = "^(hyprpicker)$" }, no_anim = true })
hl.layer_rule({ name = "selection-no-animation", match = { namespace = "^(selection)$" }, no_anim = true })
