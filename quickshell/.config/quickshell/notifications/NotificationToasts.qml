import QtQuick
import Quickshell
import Quickshell.Hyprland
import "../config"
import "../services"

PanelWindow {
    id: root

    required property var screenInfo
    readonly property var monitor: Hyprland.monitorFor(screenInfo)

    screen: screenInfo
    visible: NotificationService.toasts.length > 0 && monitor !== null && monitor.focused
    implicitWidth: 400
    implicitHeight: toastColumn.implicitHeight
    color: Theme.transparent
    aboveWindows: true
    exclusiveZone: 0
    exclusionMode: ExclusionMode.Ignore
    focusable: false

    anchors {
        top: true
        right: true
    }
    margins {
        top: Settings.barHeight + 8
        right: 18
    }

    Column {
        id: toastColumn
        width: parent.width
        spacing: 6

        Repeater {
            model: NotificationService.toasts

            delegate: NotificationToast {
                required property var modelData
                entry: modelData
            }
        }
    }
}
