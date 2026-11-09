import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    active: PopupManager.isOpen("network", screenName)

    Icon {
        text: NetworkService.wiredConnected ? "󰈀" : NetworkService.wifiIcon(NetworkService.signalStrength)
        color: NetworkService.connected ? Theme.fg0 : Theme.critical
    }

    onClicked: function(mouse) {
        if (mouse.button === Qt.LeftButton)
            PopupManager.toggle("network", screenName);
    }
}
