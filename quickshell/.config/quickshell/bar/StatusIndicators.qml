import QtQuick
import QtQuick.Layouts
import "../components"
import "../config"
import "../services"

// Transient state that only appears while it matters: recording, privacy, mute, and idle inhibition.
Row {
    id: root

    height: Settings.barHeight

    component Indicator: ModuleButton {
        id: indicator

        property string icon
        property color tint: Theme.fg0

        horizontalPadding: 8
        implicitWidth: visible ? contentWidth + horizontalPadding * 2 : 0

        Icon {
            text: indicator.icon
            color: indicator.tint
        }
    }

    // Recording: elapsed time, click to stop.
    ModuleButton {
        visible: RecordingService.running
        implicitWidth: visible ? contentWidth + horizontalPadding * 2 : 0
        horizontalPadding: 10
        onClicked: RecordingService.stop()

        Icon {
            text: "󰻃"
            color: Theme.critical
        }

        FixedText {
            text: RecordingService.elapsedText
            reserve: "00:00"
            color: Theme.critical
            font.pixelSize: Theme.body
        }
    }

    Indicator {
        visible: SessionService.screenShared
        icon: "󰹑"
        tint: Theme.critical
        interactive: false
    }

    Indicator {
        visible: SessionService.microphoneInUse && !AudioService.microphoneMuted
        icon: "󰍬"
        tint: Theme.warning
        onClicked: AudioService.toggleMicrophoneMute()
    }

    Indicator {
        visible: AudioService.microphoneMuted
        icon: "󰍭"
        tint: Theme.grey0
        onClicked: AudioService.toggleMicrophoneMute()
    }

    Indicator {
        visible: SessionService.idleInhibited
        icon: "󰅶"
        tint: Theme.accent
        onClicked: SessionService.toggleIdleInhibit()
    }
}
