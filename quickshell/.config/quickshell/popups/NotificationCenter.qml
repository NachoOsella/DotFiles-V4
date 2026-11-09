pragma ComponentBehavior: Bound

import QtQuick
import "../components"
import "../config"
import "../notifications"
import "../services"

PopupSurface {
    id: root

    popupName: "notifications"
    surfaceWidth: 460

    PopupHeader {
        title: "Notifications"
        detail: NotificationService.count > 0 ? NotificationService.count.toString() : ""

        IconButton {
            icon: NotificationService.doNotDisturb ? "󰂛" : "󰂚"
            selected: NotificationService.doNotDisturb
            onClicked: NotificationService.doNotDisturb = !NotificationService.doNotDisturb
        }

        IconButton {
            visible: NotificationService.count > 0
            icon: "󰎟"
            onClicked: NotificationService.clearAll()
        }
    }

    StyledText {
        visible: NotificationService.count === 0
        width: parent.width
        height: 80
        text: NotificationService.doNotDisturb ? "Do not disturb is on" : "No notifications"
        color: Theme.grey0
        horizontalAlignment: Text.AlignHCenter
    }

    Flickable {
        visible: NotificationService.count > 0
        width: parent.width
        height: Math.min(520, groupColumn.implicitHeight)
        contentWidth: width
        contentHeight: groupColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: groupColumn
            width: parent.width
            spacing: 14

            Repeater {
                model: NotificationService.groups

                delegate: Column {
                    id: group

                    required property var modelData
                    width: groupColumn.width
                    spacing: 6

                    Item {
                        width: parent.width
                        height: 22

                        SectionLabel {
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            text: group.modelData.appName + (group.modelData.entries.length > 1 ? "  " + group.modelData.entries.length : "")
                        }

                        IconButton {
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            icon: "󰅖"
                            buttonHeight: 22
                            iconSize: Theme.label
                            onClicked: NotificationService.dismissGroup(group.modelData.appName)
                        }
                    }

                    Repeater {
                        model: group.modelData.entries

                        delegate: NotificationCard {
                            required property var modelData
                            width: group.width
                            entry: modelData
                            showAppName: false
                        }
                    }
                }
            }
        }
    }
}
