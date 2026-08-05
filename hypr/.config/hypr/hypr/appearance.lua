-- Visual options, layouts, curves, and animations.

hl.config({
    general = {
        gaps_in = 2,
        gaps_out = 5,
        border_size = 2,
        col = {
            active_border = "rgb(a9b665)",
            inactive_border = "rgb(3c3836)",
        },
        layout = "dwindle",
        allow_tearing = false,
    },

    decoration = {
        rounding = 0,
        blur = {
            enabled = true,
            size = 3,
            passes = 3,
            new_optimizations = true,
            ignore_opacity = true,
            noise = 0,
        },
    },

    animations = {
        enabled = true,
    },

    dwindle = {
        preserve_split = true,
    },

    misc = {
        force_default_wallpaper = -1,
    },
})

-- Curves equivalent to the old bezier definitions.
hl.curve("outQuint", { type = "bezier", points = { { 0.22, 1.00 }, { 0.36, 1.00 } } })
hl.curve("inOutCubic", { type = "bezier", points = { { 0.65, 0.00 }, { 0.35, 1.00 } } })

-- Near-instant profile: preserve spatial feedback without conspicuous scaling or motion.
hl.animation({ leaf = "windows", enabled = true, speed = 5, bezier = "outQuint", style = "popin 99%" })
hl.animation({ leaf = "windowsIn", enabled = true, speed = 5, bezier = "outQuint", style = "popin 99%" })
hl.animation({ leaf = "windowsOut", enabled = true, speed = 5, bezier = "outQuint", style = "popin 99%" })
hl.animation({ leaf = "windowsMove", enabled = true, speed = 7, bezier = "outQuint" })
hl.animation({ leaf = "layers", enabled = true, speed = 5, bezier = "outQuint", style = "popin 99%" })
hl.animation({ leaf = "workspaces", enabled = true, speed = 5, bezier = "outQuint", style = "slidefade 4%" })
hl.animation({ leaf = "specialWorkspace", enabled = true, speed = 5, bezier = "outQuint", style = "slidefadevert 4%" })
hl.animation({ leaf = "border", enabled = true, speed = 8, bezier = "outQuint" })
hl.animation({ leaf = "borderangle", enabled = false })
hl.animation({ leaf = "fade", enabled = false })
