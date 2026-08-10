import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    StyledText {
        text: AudioService.volumeIcon(AudioService.volume, AudioService.muted)
        color: AudioService.muted ? Theme.grey1 : Theme.yellow
        font.family: Theme.iconFontFamily
    }

    StyledText {
        visible: !AudioService.muted
        text: Math.round(AudioService.volume * 100) + "%"
        color: Theme.yellow
    }

    onClicked: function(mouse) {
        if (mouse.button === Qt.MiddleButton)
            AudioService.toggleMute();
        else if (mouse.button === Qt.RightButton)
            Quickshell.execDetached(["pavucontrol"]);
        else
            PopupManager.toggle("audio", screenName);
    }
    onWheel: wheel => AudioService.adjustVolume((wheel.angleDelta.y > 0 ? 1 : -1) * Settings.volumeStep / 100)
}
