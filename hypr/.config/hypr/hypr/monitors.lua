-- Dynamic monitor profiles and workspace placement.

local outputs = {
    internal = {
        name = "eDP-1",
        mode = "1920x1080@60",
        position = "0x0",
        scale = 1,
    },
    external = {
        name = "HDMI-A-1",
        mode = "1920x1080@75",
        position = "1920x0",
        scale = 1,
    },
}

local function read_lid_state()
    -- Initialize correctly when Hyprland starts or reloads with the lid closed.
    local state_file = io.open("/proc/acpi/button/lid/LID/state", "r")
    if not state_file then
        return false
    end

    local state = state_file:read("*a")
    state_file:close()
    return state and state:match("closed") ~= nil
end

local lid_closed = read_lid_state()

local function configure_output(output, position)
    hl.monitor({
        output = output.name,
        mode = output.mode,
        position = position or output.position,
        scale = output.scale,
        disabled = false,
    })
end

local function output_is_active(name)
    return hl.get_monitor(name) ~= nil
end

local function move_workspace_range(first, last, monitor_name)
    for workspace_id = first, last do
        local workspace = hl.get_workspace(tostring(workspace_id))
        if workspace and (not workspace.monitor or workspace.monitor.name ~= monitor_name) then
            hl.dispatch(hl.dsp.workspace.move({
                workspace = workspace_id,
                monitor = monitor_name,
            }))
        end
    end
end

local function bind_workspace_range(first, last, monitor_name, default_workspace)
    for workspace_id = first, last do
        hl.workspace_rule({
            workspace = tostring(workspace_id),
            monitor = monitor_name,
            default = workspace_id == default_workspace,
        })
    end
end

local function restart_layer_clients()
    -- These clients may not rebind after an output is removed.
    hl.exec_cmd("pkill -x waybar 2>/dev/null || true; pkill -x hyprpaper 2>/dev/null || true; uwsm app -- waybar >/dev/null 2>&1 & uwsm app -- hyprpaper >/dev/null 2>&1 &")
end

local function apply_laptop_profile()
    local internal_was_active = output_is_active(outputs.internal.name)
    configure_output(outputs.internal)
    move_workspace_range(1, 10, outputs.internal.name)

    if not internal_was_active then
        restart_layer_clients()
    end
end

local function apply_dual_profile()
    local internal_was_active = output_is_active(outputs.internal.name)
    configure_output(outputs.external)
    configure_output(outputs.internal)
    move_workspace_range(1, 5, outputs.external.name)
    move_workspace_range(6, 10, outputs.internal.name)

    if not internal_was_active then
        restart_layer_clients()
    end
end

local function apply_docked_profile()
    if not output_is_active(outputs.external.name) then
        apply_laptop_profile()
        return
    end

    local internal_was_active = output_is_active(outputs.internal.name)
    move_workspace_range(1, 10, outputs.external.name)

    if internal_was_active then
        hl.monitor({ output = outputs.internal.name, disabled = true })
    end

    configure_output(outputs.external, "0x0")

    if internal_was_active then
        restart_layer_clients()
    end
end

local function reconcile_outputs()
    if lid_closed and output_is_active(outputs.external.name) then
        apply_docked_profile()
    elseif output_is_active(outputs.external.name) then
        apply_dual_profile()
    else
        apply_laptop_profile()
    end
end

-- Declare the normal open-laptop layout and persistent workspace ownership.
configure_output(outputs.internal)
configure_output(outputs.external)
bind_workspace_range(1, 5, outputs.external.name, 1)
bind_workspace_range(6, 10, outputs.internal.name, 6)
reconcile_outputs()

hl.bind("switch:on:Lid Switch", function()
    lid_closed = true
    reconcile_outputs()
end, { locked = true })

hl.bind("switch:off:Lid Switch", function()
    lid_closed = false
    reconcile_outputs()
end, { locked = true })

-- Reapply the active profile when an output is connected or disconnected.
hl.on("monitor.added", reconcile_outputs)
hl.on("monitor.removed", reconcile_outputs)
