import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    active: PopupManager.isOpen("audio", screenName)

    Icon {
        text: AudioService.volumeIcon(AudioService.volume, AudioService.muted)
        color: AudioService.muted ? Theme.warning : Theme.fg0
    }

    FixedText {
        text: AudioService.muted ? "mute" : Math.round(AudioService.volume * 100) + "%"
        reserve: "100%"
        color: AudioService.muted ? Theme.warning : Theme.fg0
        font.pixelSize: Theme.body
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
