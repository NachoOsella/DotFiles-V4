import QtQuick
import Quickshell
import Quickshell.Hyprland
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
    property bool hiding: false

    screen: screenInfo
    visible: false
    implicitWidth: 240
    implicitHeight: 78
    color: Theme.transparent
    aboveWindows: true
    exclusiveZone: 0
    exclusionMode: ExclusionMode.Ignore
    focusable: false
    anchors.bottom: true
    margins.bottom: 120

    function showOsd(newIcon: string, newPercentage: int, isMuted: bool, newMaximum: int): void {
        if (!monitor || !monitor.focused)
            return;
        icon = newIcon;
        percentage = Math.max(0, Math.min(150, newPercentage));
        muted = isMuted;
        maximum = newMaximum;
        hiding = false;
        visible = true;
        surface.opacity = 1;
        surface.y = 0;
        hideTimer.restart();
    }

    Rectangle {
        id: surface
        anchors.fill: parent
        color: Theme.bg1
        border.width: 1
        border.color: Theme.border
        radius: 7
        opacity: 0

        Behavior on opacity {
            NumberAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }

        Behavior on y {
            NumberAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
        }

        Column {
            anchors.centerIn: parent
            width: parent.width - 28
            spacing: 5

            StyledText {
                width: parent.width
                text: root.icon
                color: root.muted ? Theme.grey1 : Theme.fg1
                font.family: Theme.iconFontFamily
                font.pixelSize: 19
                horizontalAlignment: Text.AlignHCenter
            }

            StyledSlider {
                width: parent.width
                value: root.muted ? 0 : root.percentage
                to: root.maximum
                accent: root.muted ? Theme.grey1 : Theme.green
                enabled: false
                showHandle: false
            }

            StyledText {
                width: parent.width
                text: root.muted ? "Muted" : root.percentage + "%"
                color: Theme.fg0
                font.pixelSize: 12
                horizontalAlignment: Text.AlignHCenter
            }
        }
    }

    Timer {
        id: hideTimer
        interval: 1000
        onTriggered: {
            root.hiding = true;
            surface.opacity = 0;
            surface.y = 4;
            closeTimer.restart();
        }
    }

    Timer {
        id: closeTimer
        interval: Settings.animationFast
        onTriggered: root.visible = false
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
