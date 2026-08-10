import QtQuick
import "../config"

Item {
    id: root

    default property alias trailingData: trailing.data
    property string icon: ""
    property string label: ""
    property string detail: ""
    property color iconColor: Theme.fg0
    property bool interactive: false
    property bool selected: false

    signal clicked()

    implicitWidth: parent ? parent.width : 320
    implicitHeight: 38

    Rectangle {
        anchors.fill: parent
        radius: 2
        color: pointer.pressed ? Theme.bg4 : pointer.containsMouse || root.selected ? Theme.statusline2 : Theme.transparent

        Behavior on color {
            ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }
    }

    Row {
        anchors.left: parent.left
        anchors.leftMargin: 7
        anchors.verticalCenter: parent.verticalCenter
        spacing: 8

        StyledText {
            visible: root.icon.length > 0
            text: root.icon
            color: root.iconColor
            font.family: Theme.iconFontFamily
        }

        StyledText {
            text: root.label
            color: Theme.fg0
            font.pixelSize: Settings.smallFontSize
        }
    }

    Row {
        id: trailing
        anchors.right: parent.right
        anchors.rightMargin: 7
        anchors.verticalCenter: parent.verticalCenter
        spacing: 6

        StyledText {
            visible: root.detail.length > 0
            text: root.detail
            color: Theme.grey2
            font.pixelSize: Settings.smallFontSize
        }
    }

    MouseArea {
        id: pointer
        anchors.fill: parent
        enabled: root.interactive
        hoverEnabled: true
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: root.clicked()
    }
}
