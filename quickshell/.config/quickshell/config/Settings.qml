pragma Singleton

import Quickshell

Singleton {
    readonly property int barHeight: 38
    readonly property int mediaMaxWidth: 520
    readonly property int popupWidth: 440
    readonly property int popupMargin: 6
    readonly property int popupPadding: 16
    readonly property int animationFast: 120
    readonly property int animationNormal: 200
    // SUPER+1..0 map to workspaces 1..10. The first ones stay visible even when empty; with two monitors
    // workspace 6 is the laptop's default (hypr/monitors.lua), so it joins them.
    readonly property int workspaceCount: 10
    readonly property int persistentWorkspaces: 5
    readonly property int persistentWorkspacesDual: 6
    readonly property int volumeStep: 5
    readonly property real memoryWarningRatio: 0.8
    readonly property list<string> launcherCommand: [Quickshell.env("HOME") + "/.config/rofi/rofi-launcher.sh"]
}
