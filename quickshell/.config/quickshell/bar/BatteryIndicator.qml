import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    visible: BatteryService.available

    readonly property color stateColor: {
        if (BatteryService.charging)
            return Theme.green;
        if (BatteryService.percentage <= 15)
            return Theme.red;
        if (BatteryService.percentage <= 30)
            return Theme.yellow;
        return Theme.fg0;
    }

    StyledText {
        text: BatteryService.iconFor(BatteryService.percentage)
        color: root.stateColor
        font.family: Theme.iconFontFamily
    }

    StyledText {
        text: BatteryService.percentage + "%"
        color: root.stateColor
    }

    onClicked: PopupManager.toggle("control", screenName)
}
