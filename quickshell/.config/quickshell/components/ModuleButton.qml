import QtQuick
import QtQuick.Layouts
import "../config"

Rectangle {
    id: root

    default property alias contentData: content.data
    property color baseColor: Theme.transparent
    property color hoverColor: Theme.hoverBackground
    property color pressedColor: Theme.bg3
    property int horizontalPadding: 9
    property int contentHorizontalOffset: 0
    property int contentVerticalOffset: 0
    property bool interactive: true
    property color bottomAccentColor: Theme.transparent
    property int bottomAccentHeight: 0
    property alias hovered: pointer.containsMouse
    property alias acceptedButtons: pointer.acceptedButtons

    signal clicked(var mouse)
    signal wheel(var wheel)

    implicitWidth: content.implicitWidth + horizontalPadding * 2
    implicitHeight: Settings.barHeight
    color: Theme.transparent

    Rectangle {
        id: surface
        anchors.fill: parent
        color: !root.interactive ? root.baseColor : pointer.pressed ? root.pressedColor : pointer.containsMouse ? root.hoverColor : root.baseColor

        Behavior on color {
            ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }
    }

    RowLayout {
        id: content
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.horizontalCenterOffset: root.contentHorizontalOffset
        anchors.verticalCenter: parent.verticalCenter
        anchors.verticalCenterOffset: root.contentVerticalOffset
        height: implicitHeight
        spacing: 6
    }

    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: surface.bottom
        height: root.bottomAccentHeight
        color: root.bottomAccentColor
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
