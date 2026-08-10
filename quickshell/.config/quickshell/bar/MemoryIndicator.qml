import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    StyledText {
        text: ""
        color: Theme.grey2
        font.family: Theme.iconFontFamily
    }

    StyledText {
        text: Math.round(SystemService.memoryPercentage * 100) + "%"
        color: Theme.grey2
    }

    onClicked: function(mouse) {
        if (mouse.button === Qt.LeftButton)
            Quickshell.execDetached(["kitty", "-e", "btop"]);
    }
}
