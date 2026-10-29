pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

Singleton {
    id: root

    property bool recordMode: false
    property string selectionMode: "region"
    property bool systemAudio: true
    property bool microphone: false
    readonly property bool running: recorder.running

    function start(args: var): void {
        if (recorder.running)
            return;
        recorder.exec([Quickshell.env("HOME") + "/.config/hypr/scripts/screen-record.sh",
            systemAudio ? "1" : "0", microphone ? "1" : "0"].concat(args));
    }

    function stop(): void {
        if (recorder.running)
            recorder.signal(2);
    }

    Process {
        id: recorder
        stdout: StdioCollector { id: recorderOutput }
        stderr: StdioCollector { }
        onExited: function(exitCode) {
            const file = recorderOutput.text.trim();
            if (exitCode === 0 && file.length > 0)
                Quickshell.execDetached(["notify-send", "Recording saved", file]);
            else if (exitCode !== 0)
                Quickshell.execDetached(["notify-send", "-u", "critical", "Recording failed", "GPU Screen Recorder could not complete the recording."]);
        }
    }
}
