pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls as Controls
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "control"
    surfaceWidth: 430
    needsKeyboardFocus: true

    Column {
        width: parent.width
        spacing: 7

        StyledText {
            text: "Control center"
            color: Theme.fg1
            font.pixelSize: Settings.fontSize
            font.weight: Font.Bold
        }

        PopupRow {
            width: parent.width
            icon: NetworkService.wifiIcon(NetworkService.signalStrength)
            iconColor: NetworkService.connected ? Theme.aqua : Theme.grey1
            label: "Wi-Fi"
            detail: NetworkService.connectionLabel
            interactive: NetworkService.wifiAvailable
            onClicked: PopupManager.open("network", root.screenName)
        }

        PopupRow {
            width: parent.width
            icon: BluetoothService.enabled ? "󰂯" : "󰂲"
            iconColor: BluetoothService.connectedDevices.length > 0 ? Theme.green : BluetoothService.enabled ? Theme.blue : Theme.grey1
            label: "Bluetooth"
            detail: BluetoothService.summary
            interactive: BluetoothService.available
            onClicked: PopupManager.open("bluetooth", root.screenName)
        }

        PopupRow {
            width: parent.width
            icon: "󰂚"
            iconColor: NotificationService.count > 0 ? Theme.blue : Theme.grey1
            label: "Notifications"
            detail: NotificationService.count > 0 ? NotificationService.count.toString() : "None"
            interactive: true
            onClicked: PopupManager.open("notifications", root.screenName)
        }

        Separator { width: parent.width }

        PopupRow {
            width: parent.width
            icon: AudioService.volumeIcon(AudioService.volume, AudioService.muted)
            iconColor: AudioService.muted ? Theme.grey1 : Theme.yellow
            label: "Volume"
            detail: Math.round(AudioService.volume * 100) + "%"
            interactive: AudioService.sinkReady
            onClicked: AudioService.toggleMute()
        }

        StyledSlider {
            width: parent.width
            value: AudioService.volume
            to: 1.5
            accent: Theme.yellow
            enabled: AudioService.sinkReady
            onMoved: value => AudioService.setVolume(value)
        }

        PopupRow {
            width: parent.width
            icon: BrightnessService.iconFor(BrightnessService.percentage)
            iconColor: Theme.fg0
            label: "Brightness"
            detail: BrightnessService.available ? BrightnessService.percentage + "%" : "Unavailable"
        }

        StyledSlider {
            width: parent.width
            value: BrightnessService.percentage
            to: 100
            accent: Theme.fg0
            enabled: BrightnessService.available && !BrightnessService.busy
            onMoved: value => BrightnessService.setBrightness(value)
        }

        StyledText {
            visible: BrightnessService.errorMessage.length > 0
            width: parent.width
            text: BrightnessService.errorMessage
            color: Theme.orange
            font.pixelSize: 12
            wrapMode: Text.Wrap
        }

        Column {
            width: parent.width
            spacing: 7
            visible: BatteryService.available

            Separator { width: parent.width }

            PopupRow {
                width: parent.width
                icon: BatteryService.iconFor(BatteryService.percentage)
                iconColor: BatteryService.charging ? Theme.green : BatteryService.percentage <= 15 ? Theme.red : Theme.fg0
                label: "Battery"
                detail: BatteryService.percentage + "%"
            }

            PopupRow {
                width: parent.width
                label: "Power mode"
                detail: BatteryService.powerProfileName
            }

            Row {
                id: powerModes

                width: parent.width
                spacing: 7

                Repeater {
                    model: ["Automatic", "Performance"]

                    delegate: Controls.Button {
                        id: modeButton

                        required property int index
                        required property string modelData
                        readonly property bool automatic: index === 0

                        width: (powerModes.width - powerModes.spacing) / 2
                        height: 36
                        text: modelData
                        checkable: true
                        autoExclusive: true
                        checked: automatic ? BatteryService.automaticProfiles : !BatteryService.automaticProfiles
                        enabled: automatic || BatteryService.hasPerformanceProfile
                        hoverEnabled: true
                        focus: checked

                        onClicked: {
                            if (automatic)
                                BatteryService.setAutomaticMode();
                            else
                                BatteryService.setPerformanceMode();
                        }

                        contentItem: StyledText {
                            text: modeButton.text
                            color: !modeButton.enabled ? Theme.grey1 : modeButton.checked ? Theme.bg0 : Theme.fg0
                            font.pixelSize: Settings.smallFontSize
                            font.weight: modeButton.checked ? Font.DemiBold : Font.Normal
                            horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                            elide: Text.ElideRight
                        }

                        background: Rectangle {
                            radius: 2
                            color: modeButton.checked ? (modeButton.down ? Theme.aqua : Theme.green)
                                : modeButton.hovered || modeButton.down ? Theme.bg4 : Theme.statusline2
                            border.width: modeButton.activeFocus ? 1 : 0
                            border.color: Theme.fg0
                        }
                    }
                }
            }

            PopupRow {
                width: parent.width
                label: BatteryService.charging ? "Time to full" : "Remaining"
                detail: BatteryService.formatDuration(BatteryService.timeRemaining)
            }

            PopupRow {
                visible: BatteryService.health >= 0
                width: parent.width
                label: "Health"
                detail: BatteryService.health + "%"
            }

            PopupRow {
                visible: BatteryService.rate > 0
                width: parent.width
                label: "Energy rate"
                detail: BatteryService.rate.toFixed(1) + " W"
            }
        }
    }
}
