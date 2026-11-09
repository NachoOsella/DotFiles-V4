pragma ComponentBehavior: Bound

import QtQuick
import Quickshell.Services.UPower
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "bluetooth"
    surfaceWidth: 440

    // Peripheral batteries reported by UPower (mice, keyboards, headsets).
    readonly property var peripherals: UPower.devices.values.filter(device => device.ready && !device.isLaptopBattery && device.isPresent && device.percentage > 0)

    PopupHeader {
        title: "Bluetooth"
        detail: BluetoothService.connectedDevices.length > 0 ? BluetoothService.connectedDevices.length + " connected" : ""

        IconButton {
            icon: BluetoothService.enabled ? "󰂯" : "󰂲"
            selected: BluetoothService.enabled
            enabled: BluetoothService.available
            onClicked: BluetoothService.toggle()
        }
    }

    StyledText {
        visible: !BluetoothService.available || !BluetoothService.enabled || BluetoothService.devices.length === 0
        width: parent.width
        height: 40
        text: !BluetoothService.available ? "Bluetooth unavailable" : !BluetoothService.enabled ? "Bluetooth is off" : "No paired devices"
        color: Theme.grey0
        horizontalAlignment: Text.AlignHCenter
    }

    Column {
        visible: BluetoothService.enabled && BluetoothService.devices.length > 0
        width: parent.width
        spacing: 2

        Repeater {
            model: BluetoothService.devices

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: modelData.icon && modelData.icon.includes("head") ? "󰋋" : modelData.icon && modelData.icon.includes("mouse") ? "󰍽" : "󰂱"
                label: modelData.name || modelData.deviceName
                detail: modelData.batteryAvailable ? Math.round(modelData.battery * 100) + "%" : modelData.connected ? "Connected" : ""
                selected: modelData.connected
                interactive: true
                onClicked: BluetoothService.toggleDevice(modelData)
            }
        }
    }

    Column {
        visible: root.peripherals.length > 0
        width: parent.width
        spacing: 2

        SectionLabel { text: "Peripherals"; bottomPadding: 4 }

        Repeater {
            model: root.peripherals

            delegate: PopupRow {
                required property var modelData
                readonly property int level: Math.round(modelData.percentage * 100)
                width: parent.width
                icon: modelData.type === UPowerDeviceType.Mouse ? "󰍽" : modelData.type === UPowerDeviceType.Keyboard ? "󰌌" : modelData.type === UPowerDeviceType.Headset || modelData.type === UPowerDeviceType.Headphones ? "󰋋" : "󰂄"
                iconColor: level <= 15 ? Theme.critical : Theme.grey2
                label: modelData.model || "Device"
                detail: level + "%"
            }
        }
    }
}
