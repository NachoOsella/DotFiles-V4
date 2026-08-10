import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "power"
    surfaceWidth: 340
    property string confirmationAction: ""

    readonly property var actions: [
        { key: "lock", icon: "", label: "Lock" },
        { key: "suspend", icon: "", label: "Suspend" },
        { key: "logout", icon: "", label: "Logout" },
        { key: "reboot", icon: "", label: "Reboot" },
        { key: "poweroff", icon: "", label: "Power off" }
    ]

    function requestAction(action: string): void {
        if (action === "reboot" || action === "poweroff") {
            confirmationAction = action;
            return;
        }
        executeAction(action);
    }

    function executeAction(action: string): void {
        PopupManager.close();
        confirmationAction = "";
        if (action === "lock")
            Quickshell.execDetached(["loginctl", "lock-session"]);
        else if (action === "suspend")
            Quickshell.execDetached(["systemctl", "suspend"]);
        else if (action === "logout")
            Quickshell.execDetached(["hyprctl", "dispatch", "exit"]);
        else if (action === "reboot")
            Quickshell.execDetached(["systemctl", "reboot"]);
        else if (action === "poweroff")
            Quickshell.execDetached(["systemctl", "poweroff"]);
    }

    Column {
        width: parent.width
        spacing: 5

        StyledText {
            text: "Session"
            color: Theme.fg1
            font.pixelSize: Settings.fontSize
            font.weight: Font.Bold
        }

        Repeater {
            model: root.actions

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: modelData.icon
                iconColor: modelData.key === "poweroff" ? Theme.red : Theme.fg0
                label: modelData.label
                interactive: root.confirmationAction.length === 0
                onClicked: root.requestAction(modelData.key)
            }
        }

        Column {
            visible: root.confirmationAction.length > 0
            width: parent.width
            spacing: 7

            Separator { width: parent.width }

            StyledText {
                width: parent.width
                text: root.confirmationAction === "reboot" ? "Reboot the system?" : "Power off the system?"
                color: Theme.fg1
                horizontalAlignment: Text.AlignHCenter
            }

            Row {
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: 8

                IconButton {
                    icon: "󰅖"
                    label: "Cancel"
                    onClicked: root.confirmationAction = ""
                }

                IconButton {
                    icon: "󰄬"
                    label: "Confirm"
                    foreground: Theme.red
                    onClicked: root.executeAction(root.confirmationAction)
                }
            }
        }
    }

    Connections {
        target: root
        function onVisibleChanged(): void {
            if (!root.visible)
                root.confirmationAction = "";
        }
    }
}
