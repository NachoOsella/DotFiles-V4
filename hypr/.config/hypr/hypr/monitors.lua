-- Monitor and workspace layout.
-- The static layout is used while the laptop is open. Lid close/open events are
-- handled by scripts/lid_handler.sh to avoid full config reloads on lid close.

local internal = "eDP-1"
local external = "HDMI-A-1"

local internal_config = {
    output = internal,
    mode = "1920x1080@60",
    position = "0x0",
    scale = 1,
}

local external_config = {
    output = external,
    mode = "1920x1080@75",
    position = "1920x0",
    scale = 1,
}

local function bind_workspace_range(first, last, monitor, default_workspace)
    -- Keep workspace monitor assignment declarations compact and consistent.
    for workspace = first, last do
        hl.workspace_rule({
            workspace = tostring(workspace),
            monitor = monitor,
            default = workspace == default_workspace,
        })
    end
end

-- Apply the same open-laptop layout as the original hyprland.conf.
hl.monitor(internal_config)
hl.monitor(external_config)

-- Bind workspaces to their intended monitors while the laptop is open.
bind_workspace_range(1, 5, external, 1)
bind_workspace_range(6, 10, internal, 6)

-- Preserve lid behavior through a dedicated script instead of reloading the full
-- Lua config. This avoids transient overlap rules and keeps layer clients alive.
hl.bind("switch:on:Lid Switch", hl.dsp.exec_cmd("~/.config/hypr/scripts/lid_handler.sh close"), { locked = true })
hl.bind("switch:off:Lid Switch", hl.dsp.exec_cmd("~/.config/hypr/scripts/lid_handler.sh open"), { locked = true })
