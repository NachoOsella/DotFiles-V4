import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    StyledText {
        text: NetworkService.wiredConnected ? "󰈀" : NetworkService.wifiIcon(NetworkService.signalStrength)
        color: NetworkService.connected ? Theme.aqua : Theme.grey1
        font.family: Theme.iconFontFamily
    }

    StyledText {
        visible: NetworkService.connected && NetworkService.downloadBitsPerSecond >= 0
        text: NetworkService.formatRate(NetworkService.downloadBitsPerSecond)
        color: Theme.aqua
        font.pixelSize: Settings.smallFontSize
    }

    onClicked: function(mouse) {
        if (mouse.button === Qt.LeftButton)
            PopupManager.toggle("network", screenName);
    }
}
