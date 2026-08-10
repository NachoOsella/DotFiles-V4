import QtQuick
import "../config"

Rectangle {
    id: root

    property string icon: ""
    property string label: ""
    property color foreground: Theme.fg0
    property bool enabled: true
    property bool selected: false
    property int buttonHeight: 32
    property int horizontalPadding: 10

    signal clicked()

    implicitWidth: row.implicitWidth + horizontalPadding * 2
    implicitHeight: buttonHeight
    radius: 2
    color: !enabled ? Theme.transparent : pointer.pressed ? Theme.bg4 : selected || pointer.containsMouse ? Theme.statusline2 : Theme.transparent
    opacity: enabled ? 1 : 0.45

    Behavior on color {
        ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
    }

    Row {
        id: row
        anchors.centerIn: parent
        spacing: label.length > 0 ? 6 : 0

        StyledText {
            text: root.icon
            color: root.foreground
            font.family: Theme.iconFontFamily
        }

        StyledText {
            visible: root.label.length > 0
            text: root.label
            color: root.foreground
            font.pixelSize: Settings.smallFontSize
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
