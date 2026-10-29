import QtQuick
import Quickshell
import Quickshell.Widgets
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "notifications"
    surfaceWidth: 440

    Column {
        width: parent.width
        spacing: 8

        Row {
            width: parent.width

            StyledText {
                width: parent.width - clearButton.width
                text: NotificationService.count > 0 ? "Notifications  " + NotificationService.count : "Notifications"
                color: Theme.fg1
                font.pixelSize: Settings.fontSize
                font.weight: Font.Bold
            }

            IconButton {
                id: clearButton
                visible: NotificationService.count > 0
                icon: "󰃢"
                label: "Clear"
                onClicked: NotificationService.clearAll()
            }
        }

        StyledText {
            visible: NotificationService.count === 0
            width: parent.width
            height: 42
            text: "No notifications"
            color: Theme.grey1
            horizontalAlignment: Text.AlignHCenter
        }

        Flickable {
            visible: NotificationService.count > 0
            width: parent.width
            height: Math.min(440, listColumn.implicitHeight)
            contentWidth: width
            contentHeight: listColumn.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            Column {
                id: listColumn
                width: parent.width
                spacing: 6

                Repeater {
                    model: NotificationService.notifications

                    delegate: Rectangle {
                        id: notificationItem

                        required property var modelData
                        readonly property var notification: modelData.notification
                        readonly property string appIconSource: {
                            const iconName = notification.appIcon.toString();
                            if (iconName.startsWith("/") || iconName.startsWith("file:") || iconName.startsWith("data:"))
                                return iconName;
                            if (iconName.length > 0) {
                                const resolved = Quickshell.iconPath(iconName, true);
                                if (resolved.length > 0)
                                    return resolved;
                            }
                            return "";
                        }
                        readonly property string imageSource: notification.image.toString()
                        readonly property string iconSource: appIconSource.length > 0 ? appIconSource : imageSource
                        readonly property string attachedImageSource: appIconSource.length > 0 && imageSource !== appIconSource ? imageSource : ""

                        width: listColumn.width
                        implicitHeight: notificationContent.implicitHeight + 28
                        color: Theme.bg0
                        border.width: 1
                        border.color: Theme.border
                        radius: 4

                        Row {
                            id: notificationContent
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.top: parent.top
                            anchors.margins: 14
                            spacing: 10

                            Rectangle {
                                id: appIcon
                                width: notificationItem.iconSource.length > 0 ? 36 : 0
                                height: width
                                visible: width > 0
                                color: Theme.bg1
                                radius: Settings.popupRadius

                                Image {
                                    anchors.centerIn: parent
                                    width: 24
                                    height: 24
                                    source: notificationItem.iconSource
                                    asynchronous: true
                                    fillMode: Image.PreserveAspectFit
                                    sourceSize.width: 32
                                    sourceSize.height: 32
                                    smooth: true
                                }
                            }

                            Column {
                                width: parent.width - appIcon.width - dismissButton.width - 2 * notificationContent.spacing
                                spacing: 5

                                Row {
                                    width: parent.width

                                    StyledText {
                                        width: parent.width - timestamp.width
                                        text: notificationItem.notification.appName
                                        color: Theme.grey2
                                        font.pixelSize: 12
                                        font.weight: Font.Medium
                                    }

                                    StyledText {
                                        id: timestamp
                                        text: Qt.formatTime(notificationItem.modelData.timestamp, "HH:mm")
                                        color: Theme.grey1
                                        font.pixelSize: 11
                                    }
                                }

                                StyledText {
                                    width: parent.width
                                    text: notificationItem.notification.summary
                                    color: Theme.fg1
                                    font.pixelSize: Settings.smallFontSize
                                    font.weight: Font.Bold
                                    wrapMode: Text.Wrap
                                }

                                StyledText {
                                    visible: notificationItem.notification.body.length > 0
                                    width: parent.width
                                    text: notificationItem.notification.body
                                    color: Theme.fg0
                                    font.pixelSize: 13
                                    font.weight: Font.Normal
                                    wrapMode: Text.Wrap
                                }

                                Image {
                                    visible: notificationItem.attachedImageSource.length > 0
                                    width: parent.width
                                    height: visible ? 150 : 0
                                    source: notificationItem.attachedImageSource
                                    asynchronous: true
                                    fillMode: Image.PreserveAspectFit
                                    sourceSize.width: 360
                                    sourceSize.height: 150
                                    smooth: true
                                }

                                Row {
                                    visible: notificationItem.notification.actions.length > 0
                                    spacing: 4

                                    Repeater {
                                        model: notificationItem.notification.actions

                                        delegate: IconButton {
                                            required property var modelData
                                            label: modelData.text
                                            buttonHeight: 26
                                            onClicked: modelData.invoke()
                                        }
                                    }
                                }
                            }

                            IconButton {
                                id: dismissButton
                                icon: "󰅖"
                                buttonHeight: 26
                                horizontalPadding: 5
                                onClicked: NotificationService.dismiss(notificationItem.notification)
                            }
                        }
                    }
                }
            }
        }
    }
}
