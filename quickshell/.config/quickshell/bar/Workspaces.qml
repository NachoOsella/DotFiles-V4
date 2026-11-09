import QtQuick
import Quickshell
import Quickshell.Hyprland
import "../components"
import "../config"

Item {
    id: root

    readonly property int persistentCount: Quickshell.screens.length > 1 ? Settings.persistentWorkspacesDual : Settings.persistentWorkspaces

    implicitWidth: workspaceRow.implicitWidth + 8
    implicitHeight: Settings.barHeight

    function workspaceById(workspaceId: int): var {
        return Hyprland.workspaces.values.find(workspace => workspace.id === workspaceId) ?? null;
    }

    Row {
        id: workspaceRow
        anchors.centerIn: parent
        height: parent.height

        Repeater {
            model: Settings.workspaceCount

            delegate: Item {
                id: workspaceButton

                required property int index
                readonly property int workspaceId: index + 1
                readonly property var workspace: root.workspaceById(workspaceId)
                readonly property bool focused: workspace !== null && workspace.focused
                readonly property bool active: workspace !== null && workspace.active
                readonly property bool urgent: workspace !== null && workspace.urgent
                readonly property bool occupied: workspace !== null && workspace.toplevels.values.length > 0

                // Beyond the persistent range, show a workspace only while it has windows or is on screen.
                visible: workspaceId <= root.persistentCount || occupied || active || urgent
                width: 28
                height: workspaceRow.height

                Rectangle {
                    anchors.fill: parent
                    color: pointer.pressed ? Theme.pressed
                        : pointer.containsMouse ? Theme.hover
                        : workspaceButton.focused ? Theme.bg2 : Theme.transparent

                    Behavior on color {
                        ColorAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
                    }
                }

                StyledText {
                    anchors.fill: parent
                    horizontalAlignment: Text.AlignHCenter
                    text: workspaceButton.workspaceId
                    // Focused stands out by color alone; the other monitor's visible workspace stays a step above occupied.
                    color: workspaceButton.urgent ? Theme.critical
                        : workspaceButton.focused ? Theme.accent
                        : workspaceButton.active ? Theme.fg0
                        : workspaceButton.occupied ? Theme.grey1 : Theme.bg4
                    font.pixelSize: Theme.body
                    font.weight: workspaceButton.focused ? Font.Bold : Font.Normal
                }

                MouseArea {
                    id: pointer
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: Hyprland.dispatch("hl.dsp.focus({workspace = " + workspaceButton.workspaceId + "})")
                }
            }
        }
    }

    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.NoButton
        onWheel: wheel => Hyprland.dispatch(wheel.angleDelta.y > 0 ? "hl.dsp.focus({workspace = \"e-1\"})" : "hl.dsp.focus({workspace = \"e+1\"})")
    }
}
