import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    implicitWidth: 36
    baseColor: Theme.bg1
    hoverColor: Theme.red
    horizontalPadding: 8

    StyledText {
        text: ""
        color: root.hovered ? Theme.bg0 : Theme.grey2
        font.family: Theme.iconFontFamily
        font.pixelSize: 17
    }

    onClicked: PopupManager.toggle("power", screenName)
}
