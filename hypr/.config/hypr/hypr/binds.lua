-- Key, mouse, and switch bindings.

local programs = require("hypr.programs")
local mod = programs.main_mod

local function bind(keys, dispatcher, flags)
    -- Small wrapper keeps repeated bind calls concise and consistent.
    hl.bind(keys, dispatcher, flags)
end

local function exec(keys, command, flags)
    -- Bind a key directly to a shell command.
    bind(keys, hl.dsp.exec_cmd(command), flags)
end

-- Session utilities.
exec(mod .. " + Space", "hyprctl switchxkblayout current next")
exec(mod .. " + S", "fish -i -c \"hyprshot -m region --freeze\"")
exec(mod .. " + SHIFT + V", "cliphist list | rofi -dmenu | cliphist decode | wl-copy")
exec(mod .. " + period", "rofi -show emoji")
exec(mod .. " + SHIFT + W", "~/.config/rofi/rofi-wifi-menu.sh")

-- Application launchers and window actions.
exec(mod .. " + Return", programs.terminal)
bind(mod .. " + Q", hl.dsp.window.close())
exec(mod .. " + M", "~/.config/rofi/rofi-power-menu.sh")
exec(mod .. " + E", programs.file_manager)
bind(mod .. " + V", hl.dsp.window.float({ action = "toggle" }))
exec(mod .. " + D", programs.menu)
exec(mod .. " + C", "code")
bind(mod .. " + P", hl.dsp.window.pseudo())
bind(mod .. " + T", hl.dsp.layout("togglesplit"))
bind(mod .. " + F", hl.dsp.window.fullscreen({ mode = "maximized", action = "toggle" }))
exec(mod .. " + N", "kitty nvim")

-- Move windows with vim-style keys.
bind("SUPER + H", hl.dsp.window.move({ direction = "l" }))
bind("SUPER + L", hl.dsp.window.move({ direction = "r" }))
bind("SUPER + K", hl.dsp.window.move({ direction = "u" }))
bind("SUPER + J", hl.dsp.window.move({ direction = "d" }))

-- Resize windows with vim-style keys.
bind(mod .. " + SHIFT + h", hl.dsp.window.resize({ x = -100, y = 0, relative = true }))
bind(mod .. " + SHIFT + l", hl.dsp.window.resize({ x = 100, y = 0, relative = true }))
bind(mod .. " + SHIFT + k", hl.dsp.window.resize({ x = 0, y = -100, relative = true }))
bind(mod .. " + SHIFT + j", hl.dsp.window.resize({ x = 0, y = 40, relative = true }))

-- Move focus with arrow keys.
bind(mod .. " + left", hl.dsp.focus({ direction = "l" }))
bind(mod .. " + right", hl.dsp.focus({ direction = "r" }))
bind(mod .. " + up", hl.dsp.focus({ direction = "u" }))
bind(mod .. " + down", hl.dsp.focus({ direction = "d" }))
bind(mod .. " + Tab", hl.dsp.focus({ workspace = "previous" }))

-- Switch workspaces and move windows to workspaces.
for workspace = 1, 10 do
    local key = workspace % 10
    bind(mod .. " + " .. key, hl.dsp.focus({ workspace = workspace }))
    bind(mod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = workspace }))
end

-- Scratchpad workspace.
bind(mod .. " + B", hl.dsp.workspace.toggle_special("magic"))
bind(mod .. " + SHIFT + S", hl.dsp.window.move({ workspace = "special:magic" }))

-- Scroll through existing workspaces.
bind(mod .. " + mouse_down", hl.dsp.focus({ workspace = "e+1" }))
bind(mod .. " + mouse_up", hl.dsp.focus({ workspace = "e-1" }))

-- Move and resize windows by dragging with the mouse.
bind(mod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
bind(mod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })

-- Alt-Tab behavior: cycle to the next window and bring it to top.
bind("ALT + Tab", function()
    hl.dispatch(hl.dsp.window.cycle_next())
    hl.dispatch(hl.dsp.window.alter_zorder({ mode = "top" }))
end)

-- Spotify controls.
exec(mod .. " + U", "playerctl -p spotify volume 0.1-")
exec(mod .. " + I", "playerctl -p spotify volume 0.1+")
exec(mod .. " + Right", "playerctl -p spotify next")
exec(mod .. " + Left", "playerctl -p spotify previous")
