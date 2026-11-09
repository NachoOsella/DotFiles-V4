import QtQuick
import QtQuick.Layouts
import "../config"

// Flat, full-height bar module. The bottom accent marks the module whose popup is open.
Item {
    id: root

    default property alias contentData: content.data
    property int horizontalPadding: 10
    property bool interactive: true
    property bool active: false
    property alias hovered: pointer.containsMouse
    property alias acceptedButtons: pointer.acceptedButtons
    readonly property real contentWidth: content.implicitWidth

    signal clicked(var mouse)
    signal wheel(var wheel)

    implicitWidth: contentWidth + horizontalPadding * 2
    implicitHeight: Settings.barHeight

    Rectangle {
        anchors.fill: parent
        color: !root.interactive ? Theme.transparent : pointer.pressed ? Theme.pressed : pointer.containsMouse || root.active ? Theme.hover : Theme.transparent

        Behavior on color {
            ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }
    }

    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: 2
        color: Theme.accent
        opacity: root.active ? 1 : 0

        Behavior on opacity {
            NumberAnimation { duration: Settings.animationFast }
        }
    }

    RowLayout {
        id: content
        anchors.centerIn: parent
        spacing: 6
    }

    MouseArea {
        id: pointer
        anchors.fill: parent
        enabled: root.interactive
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: mouse => root.clicked(mouse)
        onWheel: wheel => root.wheel(wheel)
    }
}
