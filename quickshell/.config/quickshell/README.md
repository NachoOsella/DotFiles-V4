# Quickshell

Desktop shell for Hyprland in Gruvbox Material Dark Hard: top bar, popups, notifications, OSD, clipboard history, and screenshot overlay.

## Dependencies

- Quickshell 0.3.2, Hyprland 0.57 (Lua config), Qt 6
- JetBrainsMono Nerd Font, Symbols Nerd Font
- iwd + systemd-networkd, PipeWire, UPower, power-profiles-daemon
- MPRIS players (Spotifast and Spotify are recognized as Spotify)
- `cliphist` + `wl-clipboard` for clipboard history
- `brightnessctl` for brightness
- Optional: BlueZ for Bluetooth, `hyprsunset` for night light

Run with `qs -p ~/.config/quickshell`. Hyprland starts it from `hypr/autostart.lua`.

## Layout

```text
shell.qml        screens, idle inhibitor, IPC
config/          Theme (palette, type scale) and Settings (sizes, timings)
components/      shared controls
services/        singletons wrapping native APIs and the few external commands
bar/             per-screen bar modules
popups/          popups anchored to bar modules
notifications/   notification card and toasts
osd/             volume, microphone, and brightness overlay
screenshots/     region, monitor, window, and recording overlay
```

## Design rules

- Every color and font size comes from `config/Theme.qml`. Do not add literals in components.
- Green (`Theme.accent`) marks active state only. Yellow (`warning`) and red (`critical`) are reserved for warning and critical state. Everything else uses the neutral greys.
- All corners are square. Depth comes from 1 px borders and surface tones, not shadows.
- Popups share `PopupSurface`: a 2 px green top edge, a 120 ms fade and slide, and Escape to close. The bar module that owns an open popup shows a green bottom edge.
- Numbers in the bar reserve a fixed width (`FixedText`) so the layout does not shift.
- Transient indicators (recording, screen share, microphone, keep awake, high memory) appear only while they apply.

## Bar

Left: launcher and workspaces (1-5 always, 1-6 with two monitors; higher ones only while in use). Center: current track. Right: status indicators, tray, network, volume, memory (only above 80%), battery, date and time, power.

| Module | Left click | Middle / right click | Wheel |
| --- | --- | --- | --- |
| Track | media popup | play/pause | next/previous |
| Volume | audio popup | mute / pavucontrol | volume |
| Battery | control center | | |
| Clock | calendar | notifications | |
| Memory | btop | | |

The clock shows a bell when there are unread notifications and a crossed bell while Do Not Disturb is on.

## IPC

```bash
qs ipc call shell toggleControlCenter      # SUPER+C
qs ipc call shell toggleNotificationCenter # SUPER+SHIFT+N
qs ipc call shell toggleClipboard          # SUPER+SHIFT+V
qs ipc call shell togglePowerMenu          # SUPER+M
qs ipc call shell togglePopup network      # SUPER+SHIFT+W
qs ipc call shell toggleScreenshotMenu     # SUPER+S
qs ipc call shell closePopups
qs ipc call notifications toggleDoNotDisturb
qs ipc call session toggleIdleInhibit
qs ipc call session toggleNightLight
qs ipc call power auto|performance|status
```

IPC actions target the focused monitor.

## Hyprland

Layer namespaces are `quickshell:bar`, `quickshell:notifications`, `quickshell:osd`, and `quickshell:screenshot`. `hypr/rules.lua` enables blur behind the bar, toasts, OSD, and their popups.

## Notes

- Brightness writes need permission for `brightnessctl`; failures are shown in the control center.
- Keep awake uses the Wayland idle-inhibit protocol, which hypridle respects.
- The power menu accepts L, S, E, R, P while open. Reboot and power off need a second press.
