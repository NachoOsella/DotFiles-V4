pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

Singleton {
    id: root

    property real memoryPercentage: 0
    property real memoryUsedGiB: 0
    property real memoryTotalGiB: 0
    property var topMemoryPrograms: []
    property bool memoryProgramsBusy: false

    function formatMemory(rssKiB: real): string {
        if (rssKiB >= 1048576)
            return (rssKiB / 1048576).toFixed(1) + " GiB";
        return Math.max(0, Math.round(rssKiB / 1024)) + " MiB";
    }

    function refreshTopMemoryPrograms(): void {
        if (!topMemoryProcess.running)
            topMemoryProcess.exec(["ps", "-eo", "rss=,comm="]);
    }

    function updateTopMemoryPrograms(output: string): void {
        const memoryByProgram = {};
        for (const line of output.split("\n")) {
            const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
            if (!match)
                continue;

            const rssKiB = Number(match[1]);
            const name = match[2];
            if (Number.isFinite(rssKiB) && name.length > 0)
                memoryByProgram[name] = (memoryByProgram[name] || 0) + rssKiB;
        }

        const programs = [];
        for (const name in memoryByProgram)
            programs.push({ name: name, rssKiB: memoryByProgram[name] });
        programs.sort((first, second) => second.rssKiB - first.rssKiB);
        topMemoryPrograms = programs.slice(0, 10);
    }

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

    Process {
        id: topMemoryProcess

        stdout: StdioCollector { id: topMemoryOutput }

        onRunningChanged: root.memoryProgramsBusy = running
        onExited: function(exitCode) {
            if (exitCode === 0)
                root.updateTopMemoryPrograms(topMemoryOutput.text);
        }
    }

    Timer {
        interval: 10000
        repeat: true
        running: true
        onTriggered: memoryFile.reload()
    }
}
