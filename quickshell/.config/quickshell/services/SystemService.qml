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
    property string uptime: ""

    function formatMemory(memoryKiB: real): string {
        if (memoryKiB >= 1048576)
            return (memoryKiB / 1048576).toFixed(1) + " GiB";
        return Math.max(0, Math.round(memoryKiB / 1024)) + " MiB";
    }

    function refreshTopMemoryPrograms(): void {
        if (!memoryProcess.running)
            memoryProcess.exec(["ps", "-eo", "pss=,comm="]);
    }

    function updateTopMemoryPrograms(output: string): void {
        const memoryByProgram = {};
        for (const line of output.split("\n")) {
            const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
            if (!match)
                continue;

            const pssKiB = Number(match[1]);
            const name = match[2];
            if (Number.isFinite(pssKiB) && name.length > 0)
                memoryByProgram[name] = (memoryByProgram[name] || 0) + pssKiB;
        }

        const programs = [];
        for (const name in memoryByProgram)
            programs.push({ name: name, pssKiB: memoryByProgram[name] });
        programs.sort((first, second) => second.pssKiB - first.pssKiB);
        topMemoryPrograms = programs.slice(0, 10);
    }

    function updateMemory(contents: string): void {
        const values = {};
        for (const line of contents.split("\n")) {
            const match = line.match(/^([^:]+):\s+(\d+)/);
            if (match)
                values[match[1]] = Number(match[2]);
        }

        const totalKiB = values.MemTotal || 0;
        const availableKiB = values.MemAvailable || 0;
        if (totalKiB <= 0)
            return;

        const usedKiB = totalKiB - availableKiB;
        memoryPercentage = usedKiB / totalKiB;
        memoryUsedGiB = usedKiB / 1048576;
        memoryTotalGiB = totalKiB / 1048576;
    }

    function updateUptime(contents: string): void {
        const seconds = Math.floor(Number(contents.split(" ")[0]));
        if (!Number.isFinite(seconds))
            return;
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor(seconds % 86400 / 3600);
        const minutes = Math.floor(seconds % 3600 / 60);
        uptime = "up " + (days > 0 ? days + "d " : "") + (days > 0 || hours > 0 ? hours + "h " : "") + minutes + "m";
    }

    FileView {
        id: uptimeFile
        path: "/proc/uptime"
        preload: true
        printErrors: false
        onLoaded: root.updateUptime(text())
    }

    FileView {
        id: memoryFile
        path: "/proc/meminfo"
        preload: true
        printErrors: false
        onLoaded: root.updateMemory(text())
    }

    Process {
        id: memoryProcess

        stdout: StdioCollector { id: memoryOutput }

        onRunningChanged: root.memoryProgramsBusy = running
        onExited: function(exitCode) {
            if (exitCode === 0)
                root.updateTopMemoryPrograms(memoryOutput.text);
        }
    }

    Timer {
        interval: 10000
        repeat: true
        running: true
        onTriggered: {
            memoryFile.reload();
            uptimeFile.reload();
        }
    }
}
