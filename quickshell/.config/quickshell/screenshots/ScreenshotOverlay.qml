pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import "../components"
import "../config"
import "../services"

// Screenshot and recording overlay. The screen is frozen first so the capture matches what was on screen
// when the overlay opened. Modes: drag a region, click a window, or click a monitor.
PanelWindow {
    id: root

    required property var screenInfo
    readonly property var monitor: Hyprland.monitorFor(screenInfo)
    readonly property bool popupActive: PopupManager.activePopup === "screenshot"
    readonly property bool recordMode: RecordingService.recordMode
    readonly property string mode: RecordingService.selectionMode
    readonly property string scriptDirectory: Quickshell.env("HOME") + "/.config/hypr/scripts"
    property bool frozen: false
    property string frozenPath: ""
    property real startX: 0
    property real startY: 0
    property real endX: 0
    property real endY: 0
    property bool selecting: false
    property var pendingCommand: []
    property bool pendingRecording: false
    // Windows on this monitor's active workspace, in overlay coordinates.
    property var windows: []
    property var hoveredWindow: null

    readonly property real selectionX: Math.min(startX, endX)
    readonly property real selectionY: Math.min(startY, endY)
    readonly property real selectionWidth: Math.abs(endX - startX)
    readonly property real selectionHeight: Math.abs(endY - startY)

    // Dims everything except the active target.
    component Shade: Rectangle {
        color: "#80000000"
    }

    component OverlayButton: IconButton {
        buttonHeight: 36
        horizontalPadding: 12
    }

    screen: screenInfo
    visible: popupActive && frozen
    color: Theme.transparent
    aboveWindows: true
    WlrLayershell.namespace: "quickshell:screenshot"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.exclusiveZone: -1
    WlrLayershell.keyboardFocus: visible && monitor !== null && monitor.focused ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    anchors { top: true; bottom: true; left: true; right: true }

    function setMode(newMode: string): void {
        selecting = false;
        hoveredWindow = null;
        RecordingService.selectionMode = newMode;
    }

    function capture(command: var, recording: bool): void {
        selecting = false;
        pendingCommand = command;
        pendingRecording = recording;
        PopupManager.close();
        // Live captures must wait for the compositor to unmap the overlay; frozen-frame saves start at once.
        if (command.includes(frozenPath))
            captureTimer.triggered();
        else
            captureTimer.restart();
    }

    function captureRegion(x: real, y: real, width: real, height: real): void {
        const geometry = [x, y, width, height].map(value => String(Math.round(value)));
        if (recordMode)
            capture(["region", screenInfo.name].concat(geometry), true);
        else
            capture([scriptDirectory + "/screenshot-all.sh", "--frozen", frozenPath, String(root.width), String(root.height)].concat(geometry), false);
    }

    function captureMonitor(): void {
        if (recordMode)
            capture(["monitor", screenInfo.name], true);
        else
            capture([scriptDirectory + "/screenshot-all.sh", "--frozen", frozenPath], false);
    }

    function captureAll(): void {
        if (recordMode)
            capture(["all"], true);
        else
            capture([scriptDirectory + "/screenshot-all.sh"], false);
    }

    function windowAt(x: real, y: real): var {
        // Topmost first: floating windows sit above tiled ones.
        for (const window of windows) {
            if (x >= window.x && x < window.x + window.width && y >= window.y && y < window.y + window.height)
                return window;
        }
        return null;
    }

    function freezeScreen(): void {
        // Uncompressed PPM: grim writes it in ~25 ms instead of ~250 ms for PNG, so the overlay opens faster.
        frozenPath = (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/quickshell-freeze-" + screenInfo.name + "-" + Date.now() + ".ppm";
        frozen = false;
        frozenImage.source = "";
        windowQuery.running = true;
        freezeCapture.exec(["grim", "-t", "ppm", "-o", screenInfo.name, frozenPath]);
    }

    onPopupActiveChanged: {
        if (popupActive) {
            freezeScreen();
        } else {
            frozen = false;
            selecting = false;
            hoveredWindow = null;
            frozenImage.source = "";
            // Frames are ~6 MB each; drop this one unless the save script still needs it.
            if (frozenPath.length > 0 && !(pendingCommand.length > 0 && pendingCommand.includes(frozenPath)))
                Quickshell.execDetached(["rm", "-f", frozenPath]);
        }
    }

    onVisibleChanged: {
        if (visible) {
            RecordingService.recordMode = RecordingService.recordModeRequested;
            RecordingService.recordModeRequested = false;
        }
    }

    // "qs ipc call screenshot screen" captures the focused monitor from the open overlay.
    IpcHandler {
        target: "screenshot-" + root.screenInfo.name

        function screen(): void {
            if (root.visible)
                root.captureMonitor();
        }
    }

    Process {
        id: freezeCapture
        onExited: exitCode => {
            if (exitCode !== 0) {
                Quickshell.execDetached(["notify-send", "-a", "Screenshot", "-u", "critical", "Screenshot failed", "Could not freeze the screen."]);
                PopupManager.close();
                return;
            }
            frozenImage.source = "file://" + root.frozenPath;
            root.frozen = true;
        }
    }

    Process {
        id: windowQuery
        command: ["hyprctl", "clients", "-j"]
        stdout: StdioCollector { id: windowOutput }
        onExited: exitCode => {
            if (exitCode !== 0 || !root.monitor)
                return;
            const workspaceId = root.monitor.activeWorkspace ? root.monitor.activeWorkspace.id : -1;
            const originX = root.monitor.x;
            const originY = root.monitor.y;
            root.windows = JSON.parse(windowOutput.text)
                .filter(client => client.mapped && !client.hidden && client.workspace.id === workspaceId)
                .sort((first, second) => Number(second.floating) - Number(first.floating) || first.focusHistoryID - second.focusHistoryID)
                .map(client => ({
                    title: client.title || client.class,
                    x: client.at[0] - originX,
                    y: client.at[1] - originY,
                    width: client.size[0],
                    height: client.size[1]
                }));
        }
    }

    Timer {
        id: captureTimer
        interval: 60
        onTriggered: {
            if (root.pendingRecording) {
                RecordingService.start(root.pendingCommand);
            } else if (root.pendingCommand.includes(root.frozenPath)) {
                // Remove the frame once the save script has read it.
                Quickshell.execDetached(["sh", "-c", "frame=$1; shift; \"$@\"; rm -f \"$frame\"", "sh", root.frozenPath].concat(root.pendingCommand));
            } else {
                Quickshell.execDetached(root.pendingCommand);
            }
            root.pendingCommand = [];
        }
    }

    Image {
        id: frozenImage
        anchors.fill: parent
        fillMode: Image.PreserveAspectCrop
        cache: false
    }

    readonly property var highlight: mode === "window" && hoveredWindow ? hoveredWindow
        : mode === "region" && selecting ? { x: selectionX, y: selectionY, width: selectionWidth, height: selectionHeight }
        : null

    Shade {
        visible: root.highlight === null && root.mode !== "monitor"
        anchors.fill: parent
    }

    Shade {
        visible: root.mode === "monitor" && !pointer.containsMouse
        anchors.fill: parent
        color: "#40000000"
    }

    Item {
        visible: root.highlight !== null
        anchors.fill: parent

        Shade { width: parent.width; height: root.highlight ? root.highlight.y : 0 }
        Shade {
            y: root.highlight ? root.highlight.y + root.highlight.height : 0
            width: parent.width
            height: parent.height - y
        }
        Shade {
            y: root.highlight ? root.highlight.y : 0
            width: root.highlight ? root.highlight.x : 0
            height: root.highlight ? root.highlight.height : 0
        }
        Shade {
            x: root.highlight ? root.highlight.x + root.highlight.width : 0
            y: root.highlight ? root.highlight.y : 0
            width: parent.width - x
            height: root.highlight ? root.highlight.height : 0
        }

        Rectangle {
            x: root.highlight ? root.highlight.x : 0
            y: root.highlight ? root.highlight.y : 0
            width: root.highlight ? root.highlight.width : 0
            height: root.highlight ? root.highlight.height : 0
            color: Theme.transparent
            border.width: 2
            border.color: root.recordMode ? Theme.critical : Theme.accent
        }
    }

    // Monitor mode outlines the whole screen.
    Rectangle {
        visible: root.mode === "monitor" && pointer.containsMouse
        anchors.fill: parent
        color: Theme.transparent
        border.width: 3
        border.color: root.recordMode ? Theme.critical : Theme.accent
    }

    // Size label next to the region or window being captured.
    Rectangle {
        visible: root.highlight !== null && root.highlight.width > 0
        x: root.highlight ? Math.min(root.width - width - 8, root.highlight.x) : 0
        y: root.highlight ? (root.highlight.y + root.highlight.height + height + 12 < root.height
            ? root.highlight.y + root.highlight.height + 6 : Math.max(8, root.highlight.y - height - 6)) : 0
        width: sizeLabel.implicitWidth + 16
        height: 26
        color: Theme.surface
        border.width: 1
        border.color: Theme.border

        StyledText {
            id: sizeLabel
            anchors.centerIn: parent
            text: root.highlight
                ? (root.mode === "window" && root.hoveredWindow ? root.hoveredWindow.title + "  " : "")
                    + Math.round(root.highlight.width) + " × " + Math.round(root.highlight.height)
                : ""
            color: Theme.fg0
            font.pixelSize: Theme.caption
        }
    }

    MouseArea {
        id: pointer
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: root.mode === "region" ? Qt.CrossCursor : Qt.PointingHandCursor
        onPressed: mouse => {
            if (root.mode !== "region")
                return;
            root.startX = mouse.x;
            root.startY = mouse.y;
            root.endX = mouse.x;
            root.endY = mouse.y;
            root.selecting = true;
        }
        onPositionChanged: mouse => {
            if (root.mode === "window")
                root.hoveredWindow = root.windowAt(mouse.x, mouse.y);
            else if (root.selecting) {
                root.endX = Math.max(0, Math.min(root.width, mouse.x));
                root.endY = Math.max(0, Math.min(root.height, mouse.y));
            }
        }
        onReleased: mouse => {
            if (root.mode === "monitor") {
                root.captureMonitor();
            } else if (root.mode === "window") {
                const window = root.windowAt(mouse.x, mouse.y);
                if (window)
                    root.captureRegion(window.x, window.y, window.width, window.height);
            } else if (root.selecting) {
                // A tiny drag is treated as a misclick instead of a 2x2 capture.
                if (root.selectionWidth >= 4 && root.selectionHeight >= 4)
                    root.captureRegion(root.selectionX, root.selectionY, root.selectionWidth, root.selectionHeight);
                else
                    root.selecting = false;
            }
        }
    }

    // Toolbar.
    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: Settings.barHeight + 16
        width: toolbar.implicitWidth + 12
        height: toolbar.implicitHeight + 12
        color: Theme.surface
        border.width: 1
        border.color: Theme.border

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            height: 2
            color: root.recordMode ? Theme.critical : Theme.accent
        }

        Row {
            id: toolbar
            anchors.centerIn: parent
            anchors.verticalCenterOffset: 1
            spacing: 4

            OverlayButton {
                icon: "󰆞"
                label: "Region"
                selected: root.mode === "region"
                onClicked: root.setMode("region")
            }
            OverlayButton {
                icon: "󰖲"
                label: "Window"
                selected: root.mode === "window"
                onClicked: root.setMode("window")
            }
            OverlayButton {
                icon: "󰍹"
                label: "Screen"
                selected: root.mode === "monitor"
                onClicked: root.setMode("monitor")
            }
            OverlayButton {
                icon: "󰍺"
                label: "All"
                onClicked: root.captureAll()
            }

            Separator { vertical: true; height: 36 }

            OverlayButton {
                icon: root.recordMode ? "󰑋" : "󰄀"
                label: root.recordMode ? "Record" : "Photo"
                foreground: root.recordMode ? Theme.critical : Theme.fg0
                enabled: !RecordingService.running
                onClicked: RecordingService.recordMode = !RecordingService.recordMode
            }
            OverlayButton {
                visible: root.recordMode
                icon: RecordingService.systemAudio ? "󰕾" : "󰖁"
                selected: RecordingService.systemAudio
                onClicked: RecordingService.systemAudio = !RecordingService.systemAudio
            }
            OverlayButton {
                visible: root.recordMode
                icon: RecordingService.microphone ? "󰍬" : "󰍭"
                selected: RecordingService.microphone
                onClicked: RecordingService.microphone = !RecordingService.microphone
            }
        }
    }

    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 24
        width: hints.implicitWidth + 24
        height: 30
        color: Theme.surface
        border.width: 1
        border.color: Theme.border

        StyledText {
            id: hints
            anchors.centerIn: parent
            text: "R region   W window   S screen   A all   Tab photo/record   Enter screen   Esc cancel"
            color: Theme.grey1
            font.pixelSize: Theme.caption
        }
    }

    Item {
        anchors.fill: parent
        focus: root.visible
        Keys.onPressed: event => {
            switch (event.key) {
            case Qt.Key_Escape:
                PopupManager.close();
                break;
            case Qt.Key_R:
                root.setMode("region");
                break;
            case Qt.Key_W:
                root.setMode("window");
                break;
            case Qt.Key_S:
                root.setMode("monitor");
                break;
            case Qt.Key_A:
                root.captureAll();
                break;
            case Qt.Key_Tab:
                if (!RecordingService.running)
                    RecordingService.recordMode = !RecordingService.recordMode;
                break;
            case Qt.Key_Return:
            case Qt.Key_Enter:
                root.captureMonitor();
                break;
            default:
                return;
            }
            event.accepted = true;
        }
    }
}
