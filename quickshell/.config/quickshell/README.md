# Quickshell Desktop Shell

A compact Quickshell shell derived from the existing Waybar, Hyprland, Rofi, and Hyprlock setup. It preserves the 38 px Gruvbox bar while adding native media, audio, network, Bluetooth, calendar, control-center, notification, tray, OSD, and power interactions.

> [!IMPORTANT]
> Waybar, Rofi, Hyprlock, Dunst, and system-service configurations remain untouched. At the user's final request, Hyprland startup now launches Quickshell instead of Waybar, and its monitor-reconnect helper no longer relaunches Waybar.

## Target and dependencies

Targeted version: **Quickshell 0.3.0**.

Core runtime:

- Quickshell 0.3.0
- Hyprland
- Qt 6 / QtQuick
- JetBrainsMono Nerd Font and Symbols Nerd Font
- NetworkManager
- BlueZ
- PipeWire and WirePlumber
- UPower
- an MPRIS-compatible player

Command integrations:

- `rofi`: existing application launcher
- `brightnessctl`: brightness read/write fallback
- `pavucontrol`: right-click audio fallback
- `kitty -e btop`: memory-module action
- `loginctl`, `systemctl`, and `hyprctl`: session and power actions

Power profiles are not shown because `power-profiles-daemon` is not installed. No `nmcli`, `bluetoothctl`, `wpctl`, `pactl`, `playerctl`, or `hyprctl` polling is used.

## Launch and lifecycle

Launch manually:

```bash
qs -p ~/.config/quickshell
```

Prevent duplicate instances:

```bash
qs -p ~/.config/quickshell --no-duplicate
```

Stop this configuration:

```bash
qs kill -p ~/.config/quickshell
```

Files reload automatically while the shell is running. For a clean restart:

```bash
qs kill -p ~/.config/quickshell
qs -p ~/.config/quickshell
```

Debug:

```bash
qs -p ~/.config/quickshell -vv
qs list
qs ipc show
```

Use the instance ID reported by `qs list` to inspect its log:

```bash
qs log --id <instance-id> --tail 200 --no-color
```

## Architecture

```text
quickshell/
├── shell.qml                  # Screens, OSD/toast variants, IPC
├── config/                    # Central theme and dimensions
├── services/                  # Shared native state and fallbacks
├── components/                # Text, buttons, rows, sliders, surfaces
├── bar/                       # Per-screen bar and indicators
├── popups/                    # Contextual controls
├── notifications/             # Toast and history UI
└── osd/                       # Volume, microphone, brightness overlay
```

`Variants` creates a bar, notification surface, and OSD for every connected screen. Each bar uses absolute left, center, and right anchors, so media remains centered relative to its monitor rather than to the space left between side groups.

`PopupManager` keeps one major popup open at a time and records the target screen. `PopupSurface` supplies anchoring, monitor-bound adjustment, nonblocking keyboard behavior, Escape handling when keyboard focus is required, and delayed close after the pointer leaves an entered popup.

The root file uses `UseQApplication` because native StatusNotifierItem menus require QApplication mode.

## Bar modules

Left:

- Arch launcher button
- occupied, active, or urgent Hyprland workspaces
- per-monitor active-window title

Center:

- selected MPRIS player, artist, and title

Right:

- native network state and five-second throughput sample
- PipeWire volume
- memory usage
- UPower battery
- StatusNotifierItem tray
- clock and control-center access to notifications
- clock
- power menu

Only the globally focused workspace uses the green active treatment. Empty workspaces remain hidden.

Key pointer actions:

- media: left-click popup, middle/right-click play-pause, wheel previous/next;
- network: left-click network popup;
- audio: left-click popup, middle-click mute, right-click `pavucontrol`, wheel volume;
- increasing volume while muted automatically unmutes the output;
- memory: left-click `btop`;
- battery: left-click Control Center, including Bluetooth;
- clock: left-click calendar;
- power: left-click power menu.

## Native services

- **Hyprland:** workspaces, monitor mapping, focused workspace, active toplevels, dispatch
- **MPRIS:** player discovery, capabilities, metadata, artwork, position, seek, and transport controls
- **PipeWire:** default sink/source, output selection, mute, volume, and application stream nodes when exposed
- **Networking:** NetworkManager devices, Wi-Fi state, scanning, networks, connection and disconnect actions
- **Bluetooth:** BlueZ adapter and paired-device state, connection, and battery information
- **UPower:** battery state, time estimates, health, and energy rate
- **SystemTray:** icons, activation, secondary activation, scrolling, and native menus
- **Notifications:** server, actions, images, history, and expiration when explicitly enabled

Memory is read from `/proc/meminfo`. Network throughput is calculated from `/sys/class/net/<interface>/statistics` every five seconds. These reads are consolidated in shared services and do not spawn processes.

## Media selection

`MediaService` selects:

1. the first useful actively playing player;
2. Spotify when present but paused;
3. the first player with useful metadata.

The bar collapses when no player has useful metadata. The media popup only renders controls supported by the selected player's MPRIS capabilities. Its one-second position timer runs only while the popup is visible and playback is active.

## Theme and sizing

All colors live in `config/Theme.qml`. Change Gruvbox roles there rather than adding colors to individual components.

Common dimensions live in `config/Settings.qml`:

- `barHeight`: bar height and reserved space
- `moduleHeight`: internal module height
- `fontSize` and `smallFontSize`: typography
- `popupWidth`, `popupMargin`, and `popupRadius`: popup geometry
- `workspaceCount`: maximum numbered workspace considered

The configured typefaces are `Theme.fontFamily` and `Theme.iconFontFamily`.

## IPC

Available endpoints:

```bash
qs ipc call shell toggleControlCenter
qs ipc call shell toggleNotificationCenter
qs ipc call shell togglePowerMenu
qs ipc call shell togglePopup media
qs ipc call shell closePopups
qs ipc call shell showVolumeOsd
qs ipc call shell showBrightnessOsd
```

IPC actions target the currently focused monitor.

## External fallbacks

### Brightness

Quickshell 0.3.0 has no suitable native laptop-backlight API in this installation, so `BrightnessService` calls `brightnessctl` only on initial read or direct user interaction. It never polls.

The current system permits brightness reads but may deny writes. The control reports that failure and does not invoke `sudo` or `pkexec`. Grant an appropriate udev/logind permission manually if write control is desired.

### Session and power

The power menu uses direct argument arrays:

- lock: `loginctl lock-session`
- suspend: `systemctl suspend`
- logout: `hyprctl dispatch exit`
- reboot: `systemctl reboot`
- power off: `systemctl poweroff`

Reboot and power off require confirmation. These destructive commands were not executed during testing.

### Existing applications

The Arch button runs the exact existing Rofi launcher command. The memory and audio secondary actions preserve `btop` and `pavucontrol` access.

## Notifications and Dunst

Quickshell now owns `org.freedesktop.Notifications` (`Settings.notificationServerEnabled` is `true`). The Dunst user service is masked so D-Bus activation cannot take the name back:

```bash
systemctl --user mask dunst.service   # applied
```

To return to Dunst: unmask the unit, set `notificationServerEnabled` back to `false`, and restart Quickshell.

## Hyprland integration

The Lua-based Hyprland configuration now starts this shell from `hypr/autostart.lua`:

```lua
hl.exec_cmd("pgrep -x qs >/dev/null || qs -p ~/.config/quickshell --no-duplicate")
```

The monitor-reconnect helper in `hypr/monitors.lua` restarts only Hyprpaper because Quickshell handles connected screens reactively.

Optional IPC keybinds can still be added manually inside the existing `binds.lua`, where the local `exec` helper is available:

```lua
exec(mod .. " + ALT + A", "qs ipc call shell toggleControlCenter")
exec(mod .. " + ALT + N", "qs ipc call shell toggleNotificationCenter")
exec(mod .. " + ALT + P", "qs ipc call shell togglePowerMenu")
```

The `ALT` modifier avoids the current `SUPER+N` and `SUPER+P` bindings. These optional keybinds were not added automatically.

## Current limitations

- Notifications remain inactive until Dunst is manually disabled and the setting is enabled.
- Brightness writes depend on external system permissions.
- No power-profile row is shown without `power-profiles-daemon`.
- Bluetooth currently has no paired devices, so its device list is empty.
- Per-application audio rows appear only while PipeWire exposes active stream nodes.
- Waybar and Quickshell reserve separate space when both bars are visibly stacked; this is expected during side-by-side development.
