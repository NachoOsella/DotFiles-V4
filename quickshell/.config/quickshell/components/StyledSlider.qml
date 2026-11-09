import QtQuick
import "../config"

Item {
    id: root

    property real from: 0
    property real to: 1
    property real value: 0
    property color accent: Theme.accent
    property bool enabled: true
    property bool showHandle: true
    property int trackHeight: 4
    readonly property real ratio: Math.max(0, Math.min(1, (value - from) / Math.max(0.001, to - from)))

    signal moved(real value)

    implicitWidth: 150
    implicitHeight: 18
    opacity: enabled ? 1 : 0.4

    function valueForPosition(position: real): real {
        const positionRatio = Math.max(0, Math.min(1, position / Math.max(1, width)));
        return from + positionRatio * (to - from);
    }

    Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width
        height: root.trackHeight
        color: Theme.bg3
    }

    Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width * root.ratio
        height: root.trackHeight
        color: root.accent

        Behavior on width {
            enabled: !pointer.pressed
            NumberAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }
    }

    Rectangle {
        visible: root.showHandle && (pointer.containsMouse || pointer.pressed)
        x: Math.max(0, Math.min(root.width - width, root.width * root.ratio - width / 2))
        anchors.verticalCenter: parent.verticalCenter
        width: 4
        height: 14
        color: Theme.fg1
    }

    MouseArea {
        id: pointer
        anchors.fill: parent
        enabled: root.enabled
        hoverEnabled: true
        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onPressed: mouse => root.moved(root.valueForPosition(mouse.x))
        onPositionChanged: mouse => {
            if (pressed)
                root.moved(root.valueForPosition(mouse.x));
        }
        onWheel: wheel => {
            const step = (root.to - root.from) * 0.05;
            root.moved(Math.max(root.from, Math.min(root.to, root.value + (wheel.angleDelta.y > 0 ? step : -step))));
        }
    }
}
