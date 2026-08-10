import QtQuick
import Quickshell
import Quickshell.Services.Notifications
import Quickshell.Widgets
import "../components"
import "../config"
import "../services"

Rectangle {
    id: root

    required property var entry
    readonly property var notification: entry.notification

    // Keep the app icon separate from an attached notification image.
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
    readonly property string attachedImageSource: {
        const imageSource = notification.image.toString();
        return imageSource.length > 0 && imageSource !== appIconSource ? imageSource : "";
    }

    width: 400
    implicitHeight: content.implicitHeight + 26
    color: Theme.bg1
    border.width: 1
    border.color: notification.urgency === NotificationUrgency.Critical ? Theme.red : Theme.border
    radius: Settings.popupRadius

    Item {
        id: content
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.leftMargin: 16
        anchors.rightMargin: 8
        anchors.topMargin: 12
        implicitHeight: Math.max(textColumn.implicitHeight, Math.max(appIcon.height, closeButton.implicitHeight))
        height: implicitHeight

        // Small app icon, aligned with the first text line.
        Image {
            id: appIcon
            width: root.appIconSource.length > 0 ? 20 : 0
            height: root.appIconSource.length > 0 ? 20 : 0
            visible: width > 0
            anchors.left: parent.left
            anchors.top: parent.top
            source: root.appIconSource
            asynchronous: true
            fillMode: Image.PreserveAspectFit
            sourceSize.width: 32
            sourceSize.height: 32
            smooth: true
        }

        Column {
            id: textColumn
            anchors.left: appIcon.right
            anchors.leftMargin: appIcon.width > 0 ? 8 : 0
            anchors.right: closeButton.left
            anchors.rightMargin: 8
            anchors.top: parent.top
            spacing: 3

            StyledText {
                width: parent.width
                text: notification.appName
                color: Theme.grey2
                font.pixelSize: 12
            }

            StyledText {
                width: parent.width
                text: notification.summary
                color: Theme.fg1
                font.pixelSize: Settings.smallFontSize
                font.weight: Font.Bold
                wrapMode: Text.Wrap
            }

            StyledText {
                visible: notification.body.length > 0
                width: parent.width
                text: notification.body
                color: Theme.fg0
                font.pixelSize: 13
                font.weight: Font.Medium
                wrapMode: Text.Wrap
            }

            Image {
                visible: root.attachedImageSource.length > 0
                width: parent.width
                height: visible ? 180 : 0
                source: root.attachedImageSource
                asynchronous: true
                fillMode: Image.PreserveAspectFit
                sourceSize.width: 360
                sourceSize.height: 180
                smooth: true
            }

            Row {
                visible: notification.actions.length > 0
                spacing: 4

                Repeater {
                    model: notification.actions

                    delegate: IconButton {
                        required property var modelData
                        label: modelData.text
                        buttonHeight: 24
                        onClicked: modelData.invoke()
                    }
                }
            }
        }

        IconButton {
            id: closeButton
            width: implicitWidth
            height: implicitHeight
            anchors.right: parent.right
            anchors.top: parent.top
            icon: "󰅖"
            buttonHeight: 22
            horizontalPadding: 4
            onClicked: NotificationService.dismiss(root.notification)
        }
    }

    Timer {
        interval: notification.expireTimeout > 0
            ? Math.max(1500, notification.expireTimeout)
            : notification.urgency === NotificationUrgency.Critical ? 15000 : 5000
        running: true
        onTriggered: NotificationService.hideToast(root.notification)
    }
}