import QtQuick
import "../config"

Item {
    id: root

    default property alias trailingData: trailing.data
    property string icon: ""
    property string label: ""
    property string detail: ""
    property color iconColor: Theme.grey2
    property bool interactive: false
    property bool selected: false

    signal clicked()

    implicitWidth: parent ? parent.width : 320
    implicitHeight: 38

    Rectangle {
        anchors.fill: parent
        color: pointer.pressed ? Theme.pressed : pointer.containsMouse ? Theme.hover : Theme.transparent

        Behavior on color {
            ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }
    }

    Rectangle {
        visible: root.selected
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: 2
        color: Theme.accent
    }

    Icon {
        id: leadingIcon
        visible: root.icon.length > 0
        anchors.left: parent.left
        anchors.leftMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        width: 20
        text: root.icon
        color: root.selected ? Theme.accent : root.iconColor
    }

    StyledText {
        id: labelText
        anchors.left: leadingIcon.visible ? leadingIcon.right : parent.left
        anchors.leftMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        // The label keeps its natural width up to the space left after a capped detail.
        width: Math.min(implicitWidth, root.width - x - trailing.width - 20)
        text: root.label
        color: root.selected ? Theme.fg1 : Theme.fg0
    }

    Row {
        id: trailing
        anchors.right: parent.right
        anchors.rightMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        spacing: 6

        StyledText {
            visible: root.detail.length > 0
            // At most half the row so the label is never covered.
            width: Math.min(implicitWidth, root.width / 2)
            text: root.detail
            color: Theme.grey1
            font.pixelSize: Theme.label
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
