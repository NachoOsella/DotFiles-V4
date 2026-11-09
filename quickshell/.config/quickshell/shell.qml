//@ pragma UseQApplication

import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import "bar"
import "notifications"
import "osd"
import "screenshots"
import "services"

ShellRoot {
    settings.watchFiles: true

    function focusedScreenName(): string {
        if (Hyprland.focusedMonitor)
            return Hyprland.focusedMonitor.name;
        return Quickshell.screens.length > 0 ? Quickshell.screens[0].name : "";
    }

    // Keep-awake toggle. The inhibitor needs a mapped surface, so it attaches to the first bar.
    IdleInhibitor {
        enabled: SessionService.idleInhibited
        window: bars.instances.length > 0 ? bars.instances[0] : null
    }

    Variants {
        id: bars
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

    Variants {
        model: Quickshell.screens

        delegate: ScreenshotOverlay {
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

        function toggleCalculator(): void {
            PopupManager.toggle("calculator", focusedScreenName());
        }

        function toggleClipboard(): void {
            PopupManager.toggle("clipboard", focusedScreenName());
        }

        function toggleScreenshotMenu(): void {
            PopupManager.toggle("screenshot", focusedScreenName());
        }

        // Stops a running recording, otherwise opens the overlay in record mode.
        function toggleRecording(): void {
            if (RecordingService.running) {
                RecordingService.stop();
                return;
            }
            RecordingService.recordModeRequested = true;
            PopupManager.open("screenshot", focusedScreenName());
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
