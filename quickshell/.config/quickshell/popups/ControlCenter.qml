pragma ComponentBehavior: Bound

import QtQuick
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "control"
    surfaceWidth: 460

    PopupHeader {
        title: "Control center"

        IconButton {
            icon: "󰒓"
            onClicked: PopupManager.open("audio", root.screenName)
        }
    }

    Grid {
        id: toggles
        width: parent.width
        columns: 2
        columnSpacing: 8
        rowSpacing: 8

        readonly property real tileWidth: (width - columnSpacing) / 2

        Toggle {
            width: toggles.tileWidth
            icon: NetworkService.wifiEnabled ? "󰖩" : "󰖪"
            label: "Wi-Fi"
            detail: NetworkService.connectionLabel
            checked: NetworkService.wifiEnabled
            enabled: NetworkService.wifiAvailable
            hasMenu: true
            onToggled: NetworkService.toggleWifi()
            onMenuRequested: PopupManager.open("network", root.screenName)
        }

        Toggle {
            width: toggles.tileWidth
            icon: BluetoothService.enabled ? "󰂯" : "󰂲"
            label: "Bluetooth"
            detail: BluetoothService.summary
            checked: BluetoothService.enabled
            enabled: BluetoothService.available
            hasMenu: true
            onToggled: BluetoothService.toggle()
            onMenuRequested: PopupManager.open("bluetooth", root.screenName)
        }

        Toggle {
            width: toggles.tileWidth
            icon: NotificationService.doNotDisturb ? "󰂛" : "󰂚"
            label: "Do not disturb"
            detail: NotificationService.doNotDisturb ? "On" : NotificationService.count > 0 ? NotificationService.count + " unread" : "Off"
            checked: NotificationService.doNotDisturb
            hasMenu: true
            onToggled: NotificationService.doNotDisturb = !NotificationService.doNotDisturb
            onMenuRequested: PopupManager.open("notifications", root.screenName)
        }

        Toggle {
            width: toggles.tileWidth
            icon: "󰅶"
            label: "Keep awake"
            detail: SessionService.idleInhibited ? "On" : "Off"
            checked: SessionService.idleInhibited
            onToggled: SessionService.toggleIdleInhibit()
        }

        Toggle {
            width: toggles.tileWidth
            icon: "󰖔"
            label: "Night light"
            detail: !SessionService.nightLightAvailable ? "Install hyprsunset" : SessionService.nightLight ? SessionService.nightLightTemperature + "K" : "Off"
            checked: SessionService.nightLight
            enabled: SessionService.nightLightAvailable
            onToggled: SessionService.toggleNightLight()
        }

        Toggle {
            width: toggles.tileWidth
            icon: "󰓅"
            label: "Performance"
            detail: BatteryService.automaticProfiles ? "Auto · " + BatteryService.powerProfileName : "On"
            checked: !BatteryService.automaticProfiles
            enabled: BatteryService.hasPerformanceProfile
            onToggled: BatteryService.automaticProfiles ? BatteryService.setPerformanceMode() : BatteryService.setAutomaticMode()
        }
    }

    Separator { width: parent.width }

    Column {
        width: parent.width
        spacing: 4

        SliderRow {
            icon: AudioService.volumeIcon(AudioService.volume, AudioService.muted)
            value: AudioService.volume
            to: 1.5
            valueText: AudioService.muted ? "mute" : Math.round(AudioService.volume * 100) + "%"
            muted: AudioService.muted
            enabled: AudioService.sinkReady
            onIconClicked: AudioService.toggleMute()
            onMoved: value => AudioService.setVolume(value)
        }

        SliderRow {
            visible: BrightnessService.available
            icon: BrightnessService.iconFor(BrightnessService.percentage)
            value: BrightnessService.percentage
            to: 100
            valueText: BrightnessService.percentage + "%"
            enabled: !BrightnessService.busy
            onMoved: value => BrightnessService.setBrightness(value)
        }

        StyledText {
            visible: BrightnessService.errorMessage.length > 0
            width: parent.width
            text: BrightnessService.errorMessage
            color: Theme.warning
            font.pixelSize: Theme.caption
            wrapMode: Text.Wrap
        }
    }

    Item {
        visible: BatteryService.available
        width: parent.width
        height: 20

        StyledText {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: BatteryService.percentage + "%" + (BatteryService.full ? "  ·  Full"
                : BatteryService.timeRemaining > 0 ? "  ·  " + (BatteryService.charging ? "Full in " : "") + BatteryService.formatDuration(BatteryService.timeRemaining) + (BatteryService.charging ? "" : " left")
                : BatteryService.charging ? "  ·  Charging" : "")
            color: Theme.grey1
            font.pixelSize: Theme.label
        }

        StyledText {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: [BatteryService.rate > 0 ? BatteryService.rate.toFixed(1) + " W" : "",
                BatteryService.health >= 0 ? "health " + BatteryService.health + "%" : ""].filter(part => part).join("  ·  ")
            color: Theme.grey0
            font.pixelSize: Theme.label
        }
    }

    component SliderRow: Item {
        id: sliderRow

        property string icon
        property real value
        property real to: 1
        property string valueText
        property bool muted: false
        property bool enabled: true

        signal moved(real value)
        signal iconClicked()

        width: parent.width
        height: 36

        IconButton {
            id: sliderIcon
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            icon: sliderRow.icon
            foreground: sliderRow.muted ? Theme.warning : Theme.fg0
            onClicked: sliderRow.iconClicked()
        }

        StyledSlider {
            anchors.left: sliderIcon.right
            anchors.leftMargin: 8
            anchors.right: sliderValue.left
            anchors.rightMargin: 12
            anchors.verticalCenter: parent.verticalCenter
            value: sliderRow.value
            to: sliderRow.to
            accent: sliderRow.muted ? Theme.grey0 : Theme.accent
            enabled: sliderRow.enabled
            onMoved: value => sliderRow.moved(value)
        }

        StyledText {
            id: sliderValue
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: 48
            horizontalAlignment: Text.AlignRight
            text: sliderRow.valueText
            color: Theme.grey2
            font.pixelSize: Theme.label
        }
    }
}
