import QtQuick
import Quickshell
import "../components"
import "../config"

ModuleButton {
    id: root

    implicitWidth: 42
    baseColor: Theme.green
    hoverColor: Theme.aqua
    pressedColor: Theme.yellow
    horizontalPadding: 7

    StyledText {
        text: ""
        color: Theme.bg0
        font.family: Theme.iconFontFamily
        font.pixelSize: 19
        font.weight: Font.DemiBold
    }

    onClicked: Quickshell.execDetached([
        "rofi", "-show", "drun", "-theme",
        Quickshell.env("HOME") + "/.config/rofi/config.rasi"
    ])
}
