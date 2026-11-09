pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

Singleton {
    id: root

    property bool recordMode: false
    // Set by IPC before the overlay opens so it starts in record mode.
    property bool recordModeRequested: false
    property string selectionMode: "region"
    property bool systemAudio: true
    property bool microphone: false
    readonly property bool running: recorder.running
    property double startedAt: 0
    property int elapsedSeconds: 0
    readonly property string elapsedText: {
        const minutes = Math.floor(elapsedSeconds / 60);
        return minutes + ":" + String(elapsedSeconds % 60).padStart(2, "0");
    }

    function start(args: var): void {
        if (recorder.running)
            return;
        recorder.exec([Quickshell.env("HOME") + "/.config/hypr/scripts/screen-record.sh",
            systemAudio ? "1" : "0", microphone ? "1" : "0"].concat(args));
        startedAt = Date.now();
        elapsedSeconds = 0;
    }

    function stop(): void {
        if (recorder.running)
            recorder.signal(2);
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.running
        onTriggered: root.elapsedSeconds = Math.floor((Date.now() - root.startedAt) / 1000)
    }

    Process {
        id: recorder
        stdout: StdioCollector { id: recorderOutput }
        stderr: StdioCollector { id: recorderErrors }
        onExited: exitCode => {
            const file = recorderOutput.text.trim();
            // SIGINT from stop() is the normal way to finish, so gpu-screen-recorder may report it as non-zero.
            if (file.length > 0 && (exitCode === 0 || root.elapsedSeconds > 0)) {
                Quickshell.execDetached(["sh", "-c",
                    "[ -s \"$1\" ] || exit 1; python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri())' \"$1\" | wl-copy --type text/uri-list; "
                    + "notify-send -a Recording 'Recording copied' \"$(basename \"$1\")  ·  $2\"",
                    "sh", file, root.elapsedText]);
            } else {
                Quickshell.execDetached(["notify-send", "-a", "Recording", "-u", "critical", "Recording failed",
                    recorderErrors.text.trim().split("\n").pop() || "GPU Screen Recorder could not start."]);
            }
        }
    }
}
