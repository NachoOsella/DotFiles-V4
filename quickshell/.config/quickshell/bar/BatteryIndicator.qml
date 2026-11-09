import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    visible: BatteryService.available
    active: PopupManager.isOpen("control", screenName) || PopupManager.isOpen("bluetooth", screenName)

    readonly property color stateColor: BatteryService.charging ? Theme.accent
        : BatteryService.percentage <= 15 ? Theme.critical
        : BatteryService.percentage <= 30 ? Theme.warning : Theme.fg0

    Icon {
        text: BatteryService.iconFor(BatteryService.percentage)
        color: root.stateColor
    }

    FixedText {
        text: BatteryService.percentage + "%"
        reserve: "100%"
        color: root.stateColor
        font.pixelSize: Theme.body
    }

    onClicked: PopupManager.toggle("control", screenName)
}
