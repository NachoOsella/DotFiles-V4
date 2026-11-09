import QtQuick
import "../config"

// Square control-center tile: icon, label, and current state.
Rectangle {
    id: root

    property string icon: ""
    property string label: ""
    property string detail: ""
    property bool checked: false
    property bool enabled: true
    property bool hasMenu: false

    signal toggled()
    signal menuRequested()

    implicitHeight: 64
    color: !enabled ? Theme.transparent : pointer.pressed ? Theme.pressed : pointer.containsMouse ? Theme.hover : Theme.raised
    border.width: 1
    border.color: checked ? Theme.accent : Theme.border
    opacity: enabled ? 1 : 0.4

    Behavior on color {
        ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
    }

    Behavior on border.color {
        ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
    }

    Icon {
        id: tileIcon
        anchors.left: parent.left
        anchors.leftMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        width: 24
        text: root.icon
        color: root.checked ? Theme.accent : Theme.grey1
        font.pixelSize: Theme.iconLarge
    }

    Column {
        anchors.left: tileIcon.right
        anchors.leftMargin: 12
        anchors.right: menuIcon.visible ? menuIcon.left : parent.right
        anchors.rightMargin: 8
        anchors.verticalCenter: parent.verticalCenter
        spacing: 1

        StyledText {
            width: parent.width
            text: root.label
            color: root.checked ? Theme.fg1 : Theme.fg0
            font.pixelSize: Theme.label
            font.weight: Font.DemiBold
        }

        StyledText {
            width: parent.width
            text: root.detail
            color: Theme.grey1
            font.pixelSize: Theme.caption
        }
    }

    Icon {
        id: menuIcon
        visible: root.hasMenu
        anchors.right: parent.right
        anchors.rightMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        text: "󰅂"
        color: Theme.grey0
        font.pixelSize: Theme.label
    }

    MouseArea {
        id: pointer
        anchors.fill: parent
        enabled: root.enabled
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: mouse => {
            if (root.hasMenu && (mouse.button === Qt.RightButton || mouse.x > root.width - 32))
                root.menuRequested();
            else
                root.toggled();
        }
    }
}
