import QtQuick
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "bluetooth"
    surfaceWidth: 420

    Column {
        width: parent.width
        spacing: 7

        Row {
            width: parent.width

            StyledText {
                width: parent.width - bluetoothToggle.width
                text: "Bluetooth"
                color: Theme.fg1
                font.pixelSize: Settings.fontSize
                font.weight: Font.Bold
            }

            IconButton {
                id: bluetoothToggle
                icon: BluetoothService.enabled ? "󰂯" : "󰂲"
                foreground: BluetoothService.enabled ? Theme.blue : Theme.grey1
                enabled: BluetoothService.available
                onClicked: BluetoothService.toggle()
            }
        }

        PopupRow {
            width: parent.width
            icon: BluetoothService.enabled ? "󰂯" : "󰂲"
            iconColor: BluetoothService.enabled ? Theme.blue : Theme.grey1
            label: BluetoothService.available ? BluetoothService.summary : "Bluetooth unavailable"
            detail: BluetoothService.connectedDevices.length > 0 ? BluetoothService.connectedDevices.length + " connected" : ""
        }

        Separator { width: parent.width }

        StyledText {
            text: "Paired devices"
            color: Theme.grey2
            font.pixelSize: 12
        }

        StyledText {
            visible: BluetoothService.enabled && BluetoothService.devices.length === 0
            text: "No paired devices"
            color: Theme.grey1
            font.pixelSize: Settings.smallFontSize
        }

        Repeater {
            model: BluetoothService.devices

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: modelData.icon && modelData.icon.includes("head") ? "" : "󰂱"
                iconColor: modelData.connected ? Theme.green : Theme.grey2
                label: modelData.name || modelData.deviceName
                detail: modelData.batteryAvailable
                    ? Math.round(modelData.battery * 100) + "%"
                    : modelData.connected ? "Connected" : "Paired"
                selected: modelData.connected
                interactive: BluetoothService.enabled
                onClicked: BluetoothService.toggleDevice(modelData)
            }
        }
    }
}
