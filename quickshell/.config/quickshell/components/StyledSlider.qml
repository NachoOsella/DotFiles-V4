import QtQuick
import "../config"

Item {
    id: root

    property real from: 0
    property real to: 1
    property real value: 0
    property color accent: Theme.green
    property bool enabled: true
    property bool showHandle: true

    signal moved(real value)

    implicitWidth: 150
    implicitHeight: 22
    opacity: enabled ? 1 : 0.45

    function valueForPosition(position: real): real {
        const ratio = Math.max(0, Math.min(1, position / Math.max(1, width)));
        return from + ratio * (to - from);
    }

    Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width
        height: 4
        radius: 2
        color: Theme.bg5
    }

    Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        width: Math.max(0, Math.min(parent.width, parent.width * (root.value - root.from) / Math.max(0.001, root.to - root.from)))
        height: 4
        radius: 2
        color: root.accent
    }

    Rectangle {
        visible: root.showHandle
        x: Math.max(0, Math.min(root.width - width, root.width * (root.value - root.from) / Math.max(0.001, root.to - root.from) - width / 2))
        anchors.verticalCenter: parent.verticalCenter
        width: 10
        height: 10
        radius: 5
        color: root.enabled ? Theme.fg1 : Theme.grey0
    }

    MouseArea {
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
