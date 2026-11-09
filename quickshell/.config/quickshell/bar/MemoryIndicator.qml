import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

// Only visible under memory pressure; the popup lists the heaviest programs.
ModuleButton {
    id: root

    property var memoryPopup

    visible: SystemService.memoryPercentage >= Settings.memoryWarningRatio
    implicitWidth: visible ? contentWidth + horizontalPadding * 2 : 0

    onHoveredChanged: {
        if (memoryPopup)
            memoryPopup.setAnchorHovered(hovered);
    }

    Icon {
        text: "\uefc5"
        color: Theme.warning
    }

    FixedText {
        text: Math.round(SystemService.memoryPercentage * 100) + "%"
        reserve: "100%"
        color: Theme.warning
        font.pixelSize: Theme.body
    }

    onClicked: function(mouse) {
        if (mouse.button !== Qt.LeftButton)
            return;
        if (memoryPopup)
            memoryPopup.hide();
        Quickshell.execDetached(["kitty", "-e", "btop"]);
    }
}
