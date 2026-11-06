import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import "../components"
import "../config"
import "../services"

PanelWindow {
    id: root

    required property var screenInfo
    readonly property var monitor: Hyprland.monitorFor(screenInfo)
    property real startX: 0
    property real startY: 0
    property real endX: 0
    property real endY: 0
    property bool selecting: false
    property var captureCommand: []
    readonly property bool recordMode: RecordingService.recordMode
    property bool recordingCommand: false
    readonly property bool popupActive: PopupManager.activePopup === "screenshot"
    property bool frozen: false
    property string frozenPath: ""

    screen: screenInfo
    visible: popupActive && frozen
    color: Theme.transparent
    aboveWindows: true
    WlrLayershell.namespace: "screenshot-overlay"
    WlrLayershell.exclusiveZone: -1
    focusable: monitor !== null && monitor.focused
    anchors { top: true; bottom: true; left: true; right: true }

    function capture(command: var, recording: bool): void {
        selecting = false;
        captureCommand = command;
        recordingCommand = recording;
        PopupManager.close();
        captureTimer.restart();
    }

    onVisibleChanged: {
        if (!visible)
            selecting = false;
        else {
            RecordingService.selectionMode = "region";
            RecordingService.recordMode = false;
        }
    }

    onPopupActiveChanged: {
        if (popupActive)
            freezeScreen();
        else {
            frozen = false;
            frozenImage.source = "";
        }
    }

    function freezeScreen(): void {
        // Capture before the overlay maps so the frozen image has no selection UI baked in.
        if (frozenPath.length > 0)
            Quickshell.execDetached(["rm", "-f", frozenPath]);
        frozenPath = "/tmp/quickshell-screenshot-" + screenInfo.name + "-" + Date.now() + ".png";
        frozen = false;
        frozenImage.source = "";
        freezeCapture.exec(["grim", "-o", screenInfo.name, frozenPath]);
    }

    Image {
        id: frozenImage
        anchors.fill: parent
        fillMode: Image.PreserveAspectCrop
    }

    Process {
        id: freezeCapture
        onExited: function(exitCode) {
            if (exitCode !== 0) {
                Quickshell.execDetached(["notify-send", "-u", "critical", "Screenshot failed", "Could not freeze the screen."]);
                PopupManager.close();
                return;
            }
            frozenImage.source = "file://" + root.frozenPath;
            root.frozen = true;
        }
    }

    Timer {
        id: captureTimer
        // Allow the compositor to remove the selection layer before capture.
        interval: 30
        onTriggered: {
            if (root.recordingCommand)
                RecordingService.start(root.captureCommand);
            else
                Quickshell.execDetached(root.captureCommand);
        }
    }

    MouseArea {
        id: selectionArea
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: RecordingService.selectionMode === "monitor" ? Qt.PointingHandCursor : Qt.CrossCursor
        onPressed: mouse => {
            if (RecordingService.selectionMode === "monitor")
                return;
            root.startX = mouse.x;
            root.startY = mouse.y;
            root.endX = mouse.x;
            root.endY = mouse.y;
            root.selecting = true;
        }
        onPositionChanged: mouse => {
            if (root.selecting) {
                root.endX = mouse.x;
                root.endY = mouse.y;
            }
        }
        onReleased: mouse => {
            if (RecordingService.selectionMode === "monitor") {
                if (root.recordMode)
                    root.capture(["monitor", root.screenInfo.name], true);
                else
                    root.capture(["fish", "-i", "-c", "hyprshot -m output -m $argv[1]", "--", root.screenInfo.name], false);
                return;
            }
            root.endX = mouse.x;
            root.endY = mouse.y;
            const x = Math.round(Math.min(root.startX, root.endX));
            const y = Math.round(Math.min(root.startY, root.endY));
            const width = Math.round(Math.abs(root.endX - root.startX));
            const height = Math.round(Math.abs(root.endY - root.startY));
            if (width > 0 && height > 0) {
                const selection = [String(x), String(y), String(width), String(height)];
                if (root.recordMode) {
                    root.capture(["region", root.screenInfo.name].concat(selection), true);
                } else {
                    // Crop the frozen frame so the saved image matches the selection.
                    const logicalSize = [String(root.width), String(root.height)];
                    root.capture(["fish", "-i", "-c", "~/.config/hypr/scripts/screenshot-all.sh --frozen $argv", "--", root.frozenPath].concat(logicalSize).concat(selection), false);
                }
            } else {
                root.selecting = false;
            }
        }
    }

    Rectangle {
        width: parent.width
        height: root.selecting ? Math.min(root.startY, root.endY) : parent.height
        color: RecordingService.selectionMode === "monitor" && selectionArea.containsMouse ? "#33000000" : "#66000000"
    }

    Rectangle {
        visible: root.selecting
        y: Math.max(root.startY, root.endY)
        width: parent.width
        height: parent.height - y
        color: "#66000000"
    }

    Rectangle {
        visible: root.selecting
        y: Math.min(root.startY, root.endY)
        width: Math.min(root.startX, root.endX)
        height: Math.abs(root.endY - root.startY)
        color: "#66000000"
    }

    Rectangle {
        visible: root.selecting
        x: Math.max(root.startX, root.endX)
        y: Math.min(root.startY, root.endY)
        width: parent.width - x
        height: Math.abs(root.endY - root.startY)
        color: "#66000000"
    }

    Rectangle {
        visible: root.selecting
        x: Math.min(root.startX, root.endX)
        y: Math.min(root.startY, root.endY)
        width: Math.abs(root.endX - root.startX)
        height: Math.abs(root.endY - root.startY)
        color: Qt.rgba(0.66, 0.71, 0.4, 0.15)
        border.color: Theme.green
        border.width: 2
    }

    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: Settings.barHeight + 12
        width: buttons.implicitWidth + 12
        height: buttons.implicitHeight + 12
        color: Theme.popupBackground
        border.color: Theme.border
        border.width: 1
        radius: Settings.popupRadius

        Row {
            id: buttons
            anchors.centerIn: parent
            spacing: 4

            IconButton {
                icon: "󰆞"
                selected: RecordingService.selectionMode === "region"
                onClicked: {
                    root.selecting = false;
                    RecordingService.selectionMode = "region";
                }
                HoverHandler { id: regionHover }
            }
            IconButton {
                icon: "󰍹"
                selected: RecordingService.selectionMode === "monitor"
                onClicked: RecordingService.selectionMode = "monitor"
                HoverHandler { id: monitorHover }
            }
            IconButton {
                icon: "󰍺"
                onClicked: root.recordMode ? root.capture(["all"], true) : root.capture(["fish", "-i", "-c", "~/.config/hypr/scripts/screenshot-all.sh"], false)
                HoverHandler { id: allHover }
            }
            IconButton {
                icon: "󰖲"
                onClicked: root.recordMode ? root.capture(["window"], true) : root.capture(["fish", "-i", "-c", "hyprshot -m window"], false)
                HoverHandler { id: windowHover }
            }
            IconButton {
                icon: "󰑋"
                foreground: root.recordMode ? Theme.red : Theme.fg0
                selected: root.recordMode
                enabled: !RecordingService.running
                onClicked: RecordingService.recordMode = !RecordingService.recordMode
                HoverHandler { id: recordHover }
            }
            IconButton {
                visible: root.recordMode
                icon: RecordingService.systemAudio ? "󰕾" : "󰖁"
                selected: RecordingService.systemAudio
                onClicked: RecordingService.systemAudio = !RecordingService.systemAudio
                HoverHandler { id: audioHover }
            }
            IconButton {
                visible: root.recordMode
                icon: RecordingService.microphone ? "󰍬" : "󰍭"
                selected: RecordingService.microphone
                onClicked: RecordingService.microphone = !RecordingService.microphone
                HoverHandler { id: microphoneHover }
            }
        }

        Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.bottom
            anchors.topMargin: 6
            width: tooltip.implicitWidth + 16
            height: tooltip.implicitHeight + 10
            visible: tooltip.text.length > 0
            color: Theme.popupBackground
            border.color: Theme.border
            border.width: 1
            radius: Settings.popupRadius

            StyledText {
                id: tooltip
                anchors.centerIn: parent
                text: regionHover.hovered ? "Region" : monitorHover.hovered ? "Select a monitor" : allHover.hovered ? "All monitors" : windowHover.hovered ? "Window" : recordHover.hovered ? "Record" : audioHover.hovered ? "System audio" : microphoneHover.hovered ? "Microphone" : ""
                font.pixelSize: 12
            }
        }
    }

    Shortcut {
        sequence: "Escape"
        context: Qt.WindowShortcut
        onActivated: PopupManager.close()
    }
}
