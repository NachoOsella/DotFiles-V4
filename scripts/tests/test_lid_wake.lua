local bindings = {}
local display_power = "off"

hl = {
    monitor = function() end,
    get_monitor = function(name)
        return name == "eDP-1" and {} or nil
    end,
    get_workspace = function() return nil end,
    workspace_rule = function() end,
    on = function() end,
    bind = function(trigger, callback, options)
        bindings[trigger] = { callback = callback, locked = options.locked }
    end,
    dsp = {
        dpms = function(options)
            -- Hyprland defaults to toggling when the action field is missing.
            return function()
                if options.action == "on" then
                    display_power = "on"
                elseif options.action == "off" then
                    display_power = "off"
                else
                    display_power = display_power == "on" and "off" or "on"
                end
            end
        end,
    },
    dispatch = function(command) command() end,
}

dofile("hypr/.config/hypr/hypr/monitors.lua")

local close = assert(bindings["switch:on:Lid Switch"])
local open = assert(bindings["switch:off:Lid Switch"])
assert(open.locked, "Opening the lid must work while the session is locked")
close.callback()
open.callback()
assert(display_power == "on", "Opening the lid must restore display power")
open.callback()
assert(display_power == "on", "Repeated lid events must not turn the display back off")

local checked_wake, checked_sleep = false, false
for line in io.lines("hypr/.config/hypr/hypridle.conf") do
    local expression = line:match("hyprctl dispatch '([^']+)'")
    if expression then
        local command = assert(load("return " .. expression))()
        local sleeping = line:match("on%-timeout") ~= nil
        local expected = sleeping and "off" or "on"
        display_power = sleeping and "on" or "off"
        command()
        assert(display_power == expected, "Idle callback must apply its intended display state")
        command()
        assert(display_power == expected, "Repeated idle callbacks must preserve display state")
        checked_sleep = checked_sleep or sleeping
        checked_wake = checked_wake or not sleeping
    end
end
assert(checked_wake and checked_sleep, "Both idle display power paths must be tested")
print("Lid and idle DPMS regression tests passed")
