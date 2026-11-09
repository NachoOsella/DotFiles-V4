pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Services.Notifications
import Quickshell.Wayland
import "../config"
import "../services"

PanelWindow {
    id: root

    required property var screenInfo
    readonly property var monitor: Hyprland.monitorFor(screenInfo)

    screen: screenInfo
    visible: NotificationService.toasts.length > 0 && monitor !== null && monitor.focused
    implicitWidth: 420
    implicitHeight: Math.max(1, toastColumn.implicitHeight)
    color: Theme.transparent
    aboveWindows: true
    exclusiveZone: 0
    exclusionMode: ExclusionMode.Ignore
    focusable: false
    WlrLayershell.namespace: "quickshell:notifications"

    anchors {
        top: true
        right: true
    }
    margins {
        top: Settings.barHeight + 8
        right: 8
    }

    Column {
        id: toastColumn
        width: parent.width
        spacing: 6

        move: Transition {
            NumberAnimation { properties: "y"; duration: Settings.animationNormal; easing.type: Easing.OutCubic }
        }

        Repeater {
            model: NotificationService.toasts

            delegate: NotificationCard {
                id: toast

                required property var modelData
                width: toastColumn.width
                entry: modelData
                color: hovered ? Theme.bg2 : Theme.surface

                opacity: 0
                transform: Translate { id: slide; x: 24 }
                Component.onCompleted: entrance.start()

                ParallelAnimation {
                    id: entrance
                    NumberAnimation { target: toast; property: "opacity"; to: 1; duration: Settings.animationNormal; easing.type: Easing.OutCubic }
                    NumberAnimation { target: slide; property: "x"; to: 0; duration: Settings.animationNormal; easing.type: Easing.OutCubic }
                }

                MouseArea {
                    anchors.fill: parent
                    z: -1
                    onClicked: NotificationService.hideToast(toast.notification)
                }

                // The timer pauses while hovered so a toast is never pulled away mid-read.
                Timer {
                    interval: toast.notification.expireTimeout > 0
                        ? Math.max(2000, toast.notification.expireTimeout)
                        : toast.critical ? 15000 : 6000
                    running: !toast.hovered
                    onTriggered: NotificationService.hideToast(toast.notification)
                }
            }
        }
    }
}
