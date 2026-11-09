pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Pipewire

// Session toggles and privacy state that do not belong to a single device service.
Singleton {
    id: root

    property bool idleInhibited: false
    property bool nightLightAvailable: false
    readonly property bool nightLight: nightLightProcess.running
    readonly property int nightLightTemperature: 4500

    readonly property var captureStreams: Pipewire.nodes.values.filter(node => node && node.type === PwNodeType.AudioInStream)
    readonly property bool microphoneInUse: captureStreams.length > 0
    // xdg-desktop-portal-hyprland names its screencast nodes "xdph-streaming-*".
    readonly property bool screenShared: Pipewire.nodes.values.some(node => node && (node.name || "").startsWith("xdph-streaming"))

    function toggleIdleInhibit(): void {
        idleInhibited = !idleInhibited;
    }

    function toggleNightLight(): void {
        if (!nightLightAvailable)
            return;
        if (nightLightProcess.running)
            nightLightProcess.signal(15);
        else
            nightLightProcess.running = true;
    }

    PwObjectTracker {
        objects: Pipewire.nodes.values
    }

    Process {
        id: nightLightProcess
        command: ["hyprsunset", "-t", String(root.nightLightTemperature)]
    }

    Process {
        command: ["sh", "-c", "command -v hyprsunset"]
        running: true
        onExited: exitCode => root.nightLightAvailable = exitCode === 0
    }

    IpcHandler {
        target: "session"

        function toggleIdleInhibit(): bool {
            root.toggleIdleInhibit();
            return root.idleInhibited;
        }

        function toggleNightLight(): bool {
            root.toggleNightLight();
            return !root.nightLight;
        }
    }
}
