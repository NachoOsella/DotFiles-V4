pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "power"
    surfaceWidth: 420
    needsKeyboardFocus: true
    property string confirmationAction: ""

    readonly property var actions: [
        { key: "lock", icon: "󰌾", label: "Lock", shortcut: "L" },
        { key: "suspend", icon: "󰤄", label: "Sleep", shortcut: "S" },
        { key: "logout", icon: "󰍃", label: "Log out", shortcut: "E" },
        { key: "reboot", icon: "󰜉", label: "Reboot", shortcut: "R" },
        { key: "poweroff", icon: "󰐥", label: "Off", shortcut: "P" }
    ]

    function requestAction(action: string): void {
        if ((action === "reboot" || action === "poweroff") && confirmationAction !== action) {
            confirmationAction = action;
            return;
        }
        executeAction(action);
    }

    function executeAction(action: string): void {
        PopupManager.close();
        confirmationAction = "";
        const commands = {
            lock: ["loginctl", "lock-session"],
            suspend: ["systemctl", "suspend"],
            logout: ["hyprctl", "dispatch", "hl.dsp.exit()"],
            reboot: ["systemctl", "reboot"],
            poweroff: ["systemctl", "poweroff"]
        };
        Quickshell.execDetached(commands[action]);
    }

    PopupHeader {
        title: "Session"
        detail: SystemService.uptime
    }

    Row {
        id: actionRow
        width: parent.width
        spacing: 6

        Repeater {
            model: root.actions

            delegate: Rectangle {
                id: action

                required property var modelData
                readonly property bool destructive: modelData.key === "reboot" || modelData.key === "poweroff"
                readonly property bool confirming: root.confirmationAction === modelData.key

                width: (actionRow.width - actionRow.spacing * 4) / 5
                height: 80
                color: pointer.pressed ? Theme.pressed : pointer.containsMouse ? Theme.hover : Theme.raised
                border.width: 1
                border.color: confirming ? Theme.critical : pointer.containsMouse ? Theme.bg4 : Theme.border

                StyledText {
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: 5
                    text: action.modelData.shortcut
                    color: Theme.bg4
                    font.pixelSize: Theme.caption
                }

                Column {
                    anchors.centerIn: parent
                    spacing: 6

                    Icon {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: action.modelData.icon
                        color: action.confirming || (action.destructive && pointer.containsMouse) ? Theme.critical : Theme.fg0
                        font.pixelSize: Theme.iconLarge
                    }

                    StyledText {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: action.confirming ? "Confirm" : action.modelData.label
                        color: action.confirming ? Theme.critical : Theme.grey1
                        font.pixelSize: Theme.caption
                    }
                }

                MouseArea {
                    id: pointer
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.requestAction(action.modelData.key)
                }
            }
        }
    }

    StyledText {
        visible: root.confirmationAction.length > 0
        width: parent.width
        text: "Press again to " + (root.confirmationAction === "reboot" ? "reboot" : "power off") + ", Esc to cancel"
        color: Theme.critical
        font.pixelSize: Theme.caption
        horizontalAlignment: Text.AlignHCenter
    }

    Repeater {
        model: root.actions

        delegate: Item {
            required property var modelData

            Shortcut {
                sequence: modelData.shortcut
                enabled: root.shown
                context: Qt.WindowShortcut
                onActivated: root.requestAction(modelData.key)
            }
        }
    }

    onShownChanged: confirmationAction = ""
}
