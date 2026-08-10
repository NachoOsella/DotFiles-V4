//@ pragma UseQApplication

// THESIS: Preserve the incumbent 38 px Waybar at rest and reveal shell depth only through interaction; refuse dashboard-first desktop shells.
// OWN-WORLD: Gruvbox Material Dark Hard, JetBrainsMono Nerd Font, flat bar modules, one-pixel separators, modest popup radii, and restrained green/aqua state accents.
// STORY: A developer reads familiar workspaces and status at a glance, then opens contextual controls without leaving the bar.
// FIRST VIEWPORT: Arch, workspaces, and active title sit left; media is mathematically centered per monitor; compact system state remains right.
// FORM: An established-world extension in operate mode, derived directly from the existing Waybar rather than a replacement visual concept.

import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "bar"
import "notifications"
import "osd"
import "services"

ShellRoot {
    settings.watchFiles: true

    function focusedScreenName(): string {
        if (Hyprland.focusedMonitor)
            return Hyprland.focusedMonitor.name;
        return Quickshell.screens.length > 0 ? Quickshell.screens[0].name : "";
    }

    Variants {
        model: Quickshell.screens

        delegate: Bar {
            required property var modelData
            screen: modelData
        }
    }

    Variants {
        model: Quickshell.screens

        delegate: NotificationToasts {
            required property var modelData
            screenInfo: modelData
        }
    }

    Variants {
        model: Quickshell.screens

        delegate: Osd {
            required property var modelData
            screenInfo: modelData
        }
    }

    IpcHandler {
        target: "shell"

        function toggleControlCenter(): void {
            PopupManager.toggle("control", focusedScreenName());
        }

        function toggleNotificationCenter(): void {
            PopupManager.toggle("notifications", focusedScreenName());
        }

        function togglePowerMenu(): void {
            PopupManager.toggle("power", focusedScreenName());
        }

        function togglePopup(name: string): void {
            PopupManager.toggle(name, focusedScreenName());
        }

        function showVolumeOsd(): void {
            AudioService.showVolumeOsd();
        }

        function showBrightnessOsd(): void {
            BrightnessService.osdRequested(BrightnessService.iconFor(BrightnessService.percentage), BrightnessService.percentage);
        }

        function closePopups(): void {
            PopupManager.close();
        }
    }
}
