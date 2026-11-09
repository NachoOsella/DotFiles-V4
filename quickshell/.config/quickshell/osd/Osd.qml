import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland
import "../components"
import "../config"
import "../services"

PanelWindow {
    id: root

    required property var screenInfo
    readonly property var monitor: Hyprland.monitorFor(screenInfo)
    property string icon: ""
    property int percentage: 0
    property int maximum: 100
    property bool muted: false
    property bool shown: false

    screen: screenInfo
    visible: shown || surface.opacity > 0
    implicitWidth: 320
    implicitHeight: 44
    color: Theme.transparent
    aboveWindows: true
    exclusiveZone: 0
    exclusionMode: ExclusionMode.Ignore
    focusable: false
    anchors.bottom: true
    margins.bottom: 96
    WlrLayershell.namespace: "quickshell:osd"

    function showOsd(newIcon: string, newPercentage: int, isMuted: bool, newMaximum: int): void {
        if (!monitor || !monitor.focused)
            return;
        icon = newIcon;
        percentage = Math.max(0, Math.min(150, newPercentage));
        muted = isMuted;
        maximum = newMaximum;
        shown = true;
        hideTimer.restart();
    }

    Rectangle {
        id: surface
        width: parent.width
        height: parent.height
        y: root.shown ? 0 : 6
        opacity: root.shown ? 1 : 0
        color: Theme.surface
        border.width: 1
        border.color: Theme.border

        Behavior on opacity {
            NumberAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }

        Behavior on y {
            NumberAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }

        Icon {
            id: osdIcon
            anchors.left: parent.left
            anchors.leftMargin: 14
            anchors.verticalCenter: parent.verticalCenter
            width: 18
            text: root.icon
            color: root.muted ? Theme.warning : Theme.fg1
        }

        StyledText {
            id: osdValue
            anchors.right: parent.right
            anchors.rightMargin: 14
            anchors.verticalCenter: parent.verticalCenter
            width: 40
            horizontalAlignment: Text.AlignRight
            text: root.muted ? "mute" : root.percentage
            color: root.muted ? Theme.warning : Theme.fg0
            font.pixelSize: Theme.label
        }

        StyledSlider {
            anchors.left: osdIcon.right
            anchors.leftMargin: 12
            anchors.right: osdValue.left
            anchors.rightMargin: 12
            anchors.verticalCenter: parent.verticalCenter
            value: root.muted ? 0 : root.percentage
            to: root.maximum
            accent: root.percentage > 100 ? Theme.warning : Theme.accent
            enabled: true
            showHandle: false
        }
    }

    Timer {
        id: hideTimer
        interval: 1200
        onTriggered: root.shown = false
    }

    Connections {
        target: AudioService
        function onOsdRequested(icon: string, percentage: int, muted: bool): void {
            root.showOsd(icon, percentage, muted, 150);
        }
        function onMicrophoneOsdRequested(muted: bool): void {
            root.showOsd(muted ? "󰍭" : "󰍬", Math.round(AudioService.microphoneVolume * 100), muted, 100);
        }
    }

    Connections {
        target: BrightnessService
        function onOsdRequested(icon: string, percentage: int): void {
            root.showOsd(icon, percentage, false, 100);
        }
    }
}
