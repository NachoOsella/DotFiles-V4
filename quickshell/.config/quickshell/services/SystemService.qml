pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

Singleton {
    id: root

    property real memoryPercentage: 0
    property real memoryUsedGiB: 0
    property real memoryTotalGiB: 0

    function updateMemory(contents: string): void {
        const values = {};
        for (const line of contents.split("\n")) {
            const match = line.match(/^([^:]+):\s+(\d+)/);
            if (match)
                values[match[1]] = Number(match[2]);
        }
        const total = values.MemTotal || 0;
        const available = values.MemAvailable || 0;
        if (total <= 0)
            return;
        const used = total - available;
        memoryPercentage = used / total;
        memoryUsedGiB = used / 1048576;
        memoryTotalGiB = total / 1048576;
    }

    FileView {
        id: memoryFile
        path: "/proc/meminfo"
        preload: true
        printErrors: false
        onLoaded: root.updateMemory(text())
    }

    Timer {
        interval: 10000
        repeat: true
        running: true
        onTriggered: memoryFile.reload()
    }
}
