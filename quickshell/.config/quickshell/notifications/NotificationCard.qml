pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Services.Notifications
import "../components"
import "../config"
import "../services"

// One notification, shared by toasts and the notification center.
Rectangle {
    id: root

    required property var entry
    property bool showAppName: true
    readonly property var notification: entry.notification
    readonly property bool critical: notification.urgency === NotificationUrgency.Critical
    readonly property string iconSource: NotificationService.iconSource(notification)
    readonly property string attachedImage: NotificationService.attachedImage(notification)
    readonly property alias hovered: hover.hovered

    implicitHeight: content.implicitHeight + 24
    color: hover.hovered ? Theme.bg2 : Theme.raised
    border.width: 1
    border.color: Theme.border

    Behavior on color {
        ColorAnimation { duration: Settings.animationFast }
    }

    Rectangle {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: 2
        color: root.critical ? Theme.critical : Theme.transparent
    }

    HoverHandler { id: hover }

    SystemClock {
        id: clock
        precision: SystemClock.Minutes
    }

    Item {
        id: content
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 12
        implicitHeight: Math.max(textColumn.implicitHeight, appIcon.height)

        Image {
            id: appIcon
            anchors.left: parent.left
            anchors.top: parent.top
            width: root.iconSource.length > 0 ? 32 : 0
            height: width
            visible: width > 0
            source: root.iconSource
            asynchronous: true
            fillMode: Image.PreserveAspectFit
            sourceSize.width: 56
            sourceSize.height: 56
        }

        Column {
            id: textColumn
            anchors.left: appIcon.right
            anchors.leftMargin: appIcon.visible ? 12 : 0
            anchors.right: parent.right
            anchors.top: parent.top
            spacing: 3

            Item {
                width: parent.width
                height: summaryText.implicitHeight

                StyledText {
                    id: summaryText
                    anchors.left: parent.left
                    anchors.right: meta.left
                    anchors.rightMargin: 8
                    text: root.notification.summary || root.notification.appName
                    color: root.critical ? Theme.critical : Theme.fg1
                    font.weight: Font.DemiBold
                }

                Row {
                    id: meta
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 6

                    StyledText {
                        anchors.verticalCenter: parent.verticalCenter
                        visible: !hover.hovered
                        text: (root.showAppName ? root.notification.appName + "  ·  " : "")
                            + NotificationService.relativeTime(root.entry.timestamp, clock.date)
                        color: Theme.grey0
                        font.pixelSize: Theme.caption
                    }

                    IconButton {
                        anchors.verticalCenter: parent.verticalCenter
                        visible: hover.hovered
                        icon: "󰅖"
                        buttonHeight: 18
                        iconSize: Theme.label
                        onClicked: NotificationService.dismiss(root.notification)
                    }
                }
            }

            StyledText {
                visible: root.notification.body.length > 0
                width: parent.width
                text: root.notification.body
                textFormat: Text.StyledText
                color: Theme.grey2
                font.pixelSize: Theme.label
                wrapMode: Text.Wrap
                maximumLineCount: 4
            }

            Image {
                visible: root.attachedImage.length > 0
                width: parent.width
                height: visible ? 160 : 0
                source: root.attachedImage
                asynchronous: true
                fillMode: Image.PreserveAspectFit
                horizontalAlignment: Image.AlignLeft
                sourceSize.height: 320
            }

            Row {
                id: actionRow
                visible: root.notification.actions.length > 0
                width: parent.width
                topPadding: 6
                spacing: 6

                Repeater {
                    model: root.notification.actions

                    delegate: IconButton {
                        required property var modelData
                        width: (actionRow.width - actionRow.spacing * (root.notification.actions.length - 1)) / root.notification.actions.length
                        label: modelData.text
                        bordered: true
                        buttonHeight: 28
                        onClicked: modelData.invoke()
                    }
                }
            }
        }
    }
}
