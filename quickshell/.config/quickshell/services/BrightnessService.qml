pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

Singleton {
    id: root

    property int percentage: 0
    property bool available: false
    property bool busy: false
    property string errorMessage: ""
    property string operation: "read"

    signal osdRequested(string icon, int percentage)

    function refresh(): void {
        if (brightnessProcess.running)
            return;
        operation = "read";
        brightnessProcess.exec(["brightnessctl", "-m", "-c", "backlight"]);
    }

    function setBrightness(value: real): void {
        if (!available || brightnessProcess.running)
            return;
        const target = Math.max(1, Math.min(100, Math.round(value)));
        percentage = target;
        errorMessage = "";
        operation = "write";
        osdRequested(iconFor(target), target);
        brightnessProcess.exec(["brightnessctl", "-c", "backlight", "set", target + "%"]);
    }

    function iconFor(value: int): string {
        if (value < 34)
            return "󰃞";
        if (value < 67)
            return "󰃟";
        return "󰃠";
    }

    function parseOutput(output: string): void {
        const match = output.match(/,(\d+)%[,\n]/);
        if (!match)
            return;
        percentage = Number(match[1]);
        available = true;
    }

    Process {
        id: brightnessProcess
        stdout: StdioCollector { id: brightnessOutput }
        stderr: StdioCollector { id: brightnessError }

        onRunningChanged: root.busy = running
        onExited: function(exitCode) {
            if (exitCode === 0) {
                if (root.operation === "read")
                    root.parseOutput(brightnessOutput.text);
                else
                    root.refresh();
            } else {
                root.errorMessage = root.operation === "write"
                    ? "Brightness change denied. Grant brightnessctl write permission."
                    : "Brightness is unavailable.";
            }
        }
    }

    Component.onCompleted: refresh()
}
