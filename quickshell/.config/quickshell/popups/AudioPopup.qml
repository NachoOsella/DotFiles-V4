import QtQuick
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "audio"
    surfaceWidth: 430

    Column {
        width: parent.width
        spacing: 8

        StyledText {
            text: "Audio"
            color: Theme.fg1
            font.pixelSize: Settings.fontSize
            font.weight: Font.Bold
        }

        StyledText {
            width: parent.width
            text: AudioService.sinkName
            color: Theme.grey2
            font.pixelSize: 12
        }

        Item {
            width: parent.width
            height: 38

            IconButton {
                id: volumeButton
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                icon: AudioService.volumeIcon(AudioService.volume, AudioService.muted)
                foreground: AudioService.muted ? Theme.grey1 : Theme.yellow
                onClicked: AudioService.toggleMute()
            }

            StyledText {
                id: volumeValue
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                width: 42
                horizontalAlignment: Text.AlignRight
                text: Math.round(AudioService.volume * 100) + "%"
                color: Theme.fg0
                font.pixelSize: Settings.smallFontSize
            }

            StyledSlider {
                anchors.left: volumeButton.right
                anchors.leftMargin: 8
                anchors.right: volumeValue.left
                anchors.rightMargin: 8
                anchors.verticalCenter: parent.verticalCenter
                value: AudioService.volume
                to: 1.5
                accent: Theme.yellow
                enabled: AudioService.sinkReady
                onMoved: value => AudioService.setVolume(value)
            }
        }

        Separator { width: parent.width }

        StyledText {
            text: "Outputs"
            color: Theme.grey2
            font.pixelSize: 12
        }

        Repeater {
            model: AudioService.outputNodes

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: "󰓃"
                label: modelData.description || modelData.nickname || modelData.name
                detail: modelData === AudioService.sink ? "Default" : ""
                selected: modelData === AudioService.sink
                interactive: modelData !== AudioService.sink
                onClicked: AudioService.setDefaultOutput(modelData)
            }
        }

        Separator { width: parent.width }

        PopupRow {
            width: parent.width
            icon: AudioService.microphoneMuted ? "󰍭" : "󰍬"
            label: "Microphone"
            detail: AudioService.sourceReady ? Math.round(AudioService.microphoneVolume * 100) + "%" : "Unavailable"
            interactive: AudioService.sourceReady
            onClicked: AudioService.toggleMicrophoneMute()
        }

        StyledSlider {
            width: parent.width
            visible: AudioService.sourceReady
            value: AudioService.microphoneVolume
            accent: Theme.aqua
            onMoved: value => {
                if (AudioService.sourceReady)
                    AudioService.source.audio.volume = value;
            }
        }

        Column {
            width: parent.width
            spacing: 4
            visible: AudioService.streamNodes.length > 0

            Separator { width: parent.width }

            StyledText {
                text: "Applications"
                color: Theme.grey2
                font.pixelSize: 12
            }

            Repeater {
                model: AudioService.streamNodes

                delegate: Column {
                    required property var modelData
                    width: parent.width
                    spacing: 2

                    PopupRow {
                        width: parent.width
                        icon: "󰎈"
                        label: modelData.description || modelData.nickname || modelData.name
                        detail: modelData.ready && modelData.audio ? Math.round(modelData.audio.volume * 100) + "%" : ""
                    }

                    StyledSlider {
                        width: parent.width
                        value: modelData.ready && modelData.audio ? modelData.audio.volume : 0
                        accent: Theme.purple
                        enabled: modelData.ready && modelData.audio !== null
                        onMoved: value => AudioService.setNodeVolume(modelData, value)
                    }
                }
            }
        }
    }
}
