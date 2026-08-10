import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    visible: NotificationService.count > 0
    implicitWidth: visible ? contentWidth : 0
    readonly property int contentWidth: 44

    StyledText {
        text: "󰂚"
        color: Theme.blue
        font.family: Theme.iconFontFamily
    }

    StyledText {
        text: NotificationService.count
        color: Theme.fg0
        font.pixelSize: Settings.smallFontSize
    }

    onClicked: PopupManager.toggle("notifications", screenName)
}
