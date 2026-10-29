import QtQuick
import Quickshell
import Quickshell.Hyprland
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

    screen: screenInfo
    visible: PopupManager.activePopup === "screenshot"
    color: Theme.transparent
    aboveWindows: true
    exclusiveZone: 0
    exclusionMode: ExclusionMode.Ignore
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

    Timer {
        id: captureTimer
        interval: 250
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
                const geometry = [root.screenInfo.name, String(x), String(y), String(width), String(height)];
                if (root.recordMode)
                    root.capture(["region"].concat(geometry), true);
                else
                    root.capture(["fish", "-i", "-c", "~/.config/hypr/scripts/screenshot-all.sh $argv", "--"].concat(geometry), false);
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
