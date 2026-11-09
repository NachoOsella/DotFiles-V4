pragma ComponentBehavior: Bound

import QtQuick
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "audio"
    surfaceWidth: 460

    component VolumeRow: Item {
        id: volumeRow

        property string icon
        property string label
        property real value
        property real to: 1
        property bool muted: false
        property bool enabled: true

        signal moved(real value)
        signal iconClicked()

        width: parent.width
        height: 56

        IconButton {
            id: rowIcon
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            icon: volumeRow.icon
            foreground: volumeRow.muted ? Theme.warning : Theme.fg0
            onClicked: volumeRow.iconClicked()
        }

        StyledText {
            anchors.left: rowIcon.right
            anchors.leftMargin: 8
            anchors.right: rowValue.left
            anchors.rightMargin: 8
            anchors.top: parent.top
            anchors.topMargin: 4
            text: volumeRow.label
            color: Theme.fg0
            font.pixelSize: Theme.label
        }

        StyledText {
            id: rowValue
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.topMargin: 4
            text: volumeRow.muted ? "mute" : Math.round(volumeRow.value * 100) + "%"
            color: volumeRow.muted ? Theme.warning : Theme.grey1
            font.pixelSize: Theme.label
        }

        StyledSlider {
            anchors.left: rowIcon.right
            anchors.leftMargin: 8
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.bottomMargin: 4
            value: volumeRow.value
            to: volumeRow.to
            accent: volumeRow.muted ? Theme.grey0 : volumeRow.value > 1 ? Theme.warning : Theme.accent
            enabled: volumeRow.enabled
            onMoved: value => volumeRow.moved(value)
        }
    }

    PopupHeader { title: "Audio" }

    VolumeRow {
        icon: AudioService.volumeIcon(AudioService.volume, AudioService.muted)
        label: AudioService.sinkReady ? AudioService.nodeLabel(AudioService.sink) : "No output"
        value: AudioService.volume
        to: 1.5
        muted: AudioService.muted
        enabled: AudioService.sinkReady
        onIconClicked: AudioService.toggleMute()
        onMoved: value => AudioService.setVolume(value)
    }

    VolumeRow {
        visible: AudioService.sourceReady
        icon: AudioService.microphoneMuted ? "󰍭" : "󰍬"
        label: AudioService.nodeLabel(AudioService.source)
        value: AudioService.microphoneVolume
        muted: AudioService.microphoneMuted
        onIconClicked: AudioService.toggleMicrophoneMute()
        onMoved: value => AudioService.setNodeVolume(AudioService.source, value)
    }

    Column {
        visible: AudioService.outputNodes.length > 1
        width: parent.width
        spacing: 2

        SectionLabel { text: "Output"; bottomPadding: 4 }

        Repeater {
            model: AudioService.outputNodes

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: "󰓃"
                label: AudioService.nodeLabel(modelData)
                selected: modelData === AudioService.sink
                interactive: modelData !== AudioService.sink
                onClicked: AudioService.setDefaultOutput(modelData)
            }
        }
    }

    Column {
        visible: AudioService.streamNodes.length > 0
        width: parent.width
        spacing: 0

        SectionLabel { text: "Applications"; bottomPadding: 4 }

        Repeater {
            model: AudioService.streamNodes

            delegate: VolumeRow {
                required property var modelData
                icon: "󰎈"
                label: AudioService.streamLabel(modelData)
                value: modelData.ready && modelData.audio ? modelData.audio.volume : 0
                muted: modelData.ready && modelData.audio ? modelData.audio.muted : false
                enabled: modelData.ready && modelData.audio !== null
                onIconClicked: {
                    if (modelData.audio)
                        modelData.audio.muted = !modelData.audio.muted;
                }
                onMoved: value => AudioService.setNodeVolume(modelData, value)
            }
        }
    }
}
