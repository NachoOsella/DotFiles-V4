import QtQuick
import "../config"

Rectangle {
    id: root

    property string icon: ""
    property string label: ""
    property color foreground: Theme.fg0
    property bool enabled: true
    property bool selected: false
    property bool bordered: false
    property int buttonHeight: 34
    property int horizontalPadding: 9
    property int iconSize: Theme.icon

    signal clicked()

    implicitWidth: label.length > 0 ? row.implicitWidth + horizontalPadding * 2 : buttonHeight
    implicitHeight: buttonHeight
    color: !enabled ? Theme.transparent : pointer.pressed ? Theme.pressed : selected || pointer.containsMouse ? Theme.hover : Theme.transparent
    border.width: bordered || selected ? 1 : 0
    border.color: selected ? Theme.accent : Theme.border
    opacity: enabled ? 1 : 0.4

    Behavior on color {
        ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
    }

    Row {
        id: row
        anchors.centerIn: parent
        spacing: 7

        Icon {
            visible: root.icon.length > 0
            anchors.verticalCenter: parent.verticalCenter
            text: root.icon
            color: root.selected ? Theme.accent : root.foreground
            font.pixelSize: root.iconSize
        }

        StyledText {
            visible: root.label.length > 0
            anchors.verticalCenter: parent.verticalCenter
            text: root.label
            color: root.selected ? Theme.fg1 : root.foreground
            font.pixelSize: Theme.label
        }
    }

    MouseArea {
        id: pointer
        anchors.fill: parent
        enabled: root.enabled
        hoverEnabled: true
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: root.clicked()
    }
}
