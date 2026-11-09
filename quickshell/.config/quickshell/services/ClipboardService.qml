pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

// Reads and restores cliphist entries. Image previews are decoded on demand into the runtime directory.
Singleton {
    id: root

    property var entries: []
    property bool loading: false
    readonly property string previewDirectory: (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/quickshell-clipboard"
    readonly property int historyLimit: 60

    function refresh(): void {
        if (!listProcess.running)
            listProcess.running = true;
    }

    function parse(output: string): void {
        const parsed = [];
        for (const line of output.split("\n")) {
            const tab = line.indexOf("\t");
            if (tab <= 0)
                continue;
            const id = line.slice(0, tab);
            const preview = line.slice(tab + 1);
            const image = preview.match(/^\[\[ binary data .+ (\w+) (\d+x\d+) \]\]$/);
            parsed.push({
                id: id,
                text: image ? image[2] + "  " + image[1].toUpperCase() : preview.replace(/\s+/g, " ").trim(),
                image: image !== null,
                previewPath: image ? previewDirectory + "/" + id + "." + image[1] : ""
            });
            if (parsed.length >= historyLimit)
                break;
        }
        entries = parsed;
    }

    function restore(entry: var): void {
        Quickshell.execDetached(["sh", "-c", "printf '%s' \"$1\" | cliphist decode | wl-copy", "sh", entry.id]);
    }

    function remove(entry: var): void {
        Quickshell.execDetached(["sh", "-c", "printf '%s\\t\\n' \"$1\" | cliphist delete", "sh", entry.id]);
        entries = entries.filter(candidate => candidate.id !== entry.id);
    }

    function clear(): void {
        Quickshell.execDetached(["cliphist", "wipe"]);
        entries = [];
    }

    Process {
        id: listProcess
        command: ["sh", "-c", "mkdir -p \"$1\"; cliphist list", "sh", root.previewDirectory]
        stdout: StdioCollector { id: listOutput }
        onRunningChanged: root.loading = running
        onExited: exitCode => {
            if (exitCode === 0)
                root.parse(listOutput.text);
        }
    }
}
