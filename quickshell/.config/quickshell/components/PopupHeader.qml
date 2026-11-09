import QtQuick
import "../config"

// Popup title with optional trailing controls.
Item {
    id: root

    default property alias trailingData: trailing.data
    property string title: ""
    property string detail: ""

    width: parent ? parent.width : 0
    implicitHeight: 34

    Row {
        anchors.left: parent.left
        anchors.right: trailing.left
        anchors.rightMargin: 8
        anchors.verticalCenter: parent.verticalCenter
        spacing: 10

        StyledText {
            anchors.verticalCenter: parent.verticalCenter
            text: root.title
            color: Theme.fg1
            font.pixelSize: Theme.title
            font.weight: Font.Bold
        }

        StyledText {
            visible: root.detail.length > 0
            anchors.verticalCenter: parent.verticalCenter
            text: root.detail
            color: Theme.grey1
            font.pixelSize: Theme.label
        }
    }

    Row {
        id: trailing
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: 2
    }
}
