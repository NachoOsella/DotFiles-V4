import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    visible: MediaService.available
    implicitWidth: visible ? Math.min(mediaRow.implicitWidth + 26, Settings.mediaMaxWidth) : 0
    baseColor: Theme.bg1
    hoverColor: Theme.statusline2
    border.width: visible ? 1 : 0
    border.color: MediaService.playing ? Theme.bg3 : Theme.bg5
    horizontalPadding: 13
    bottomAccentHeight: visible ? 2 : 0
    bottomAccentColor: MediaService.playing ? Theme.green : Theme.bg5

    Row {
        id: mediaRow
        spacing: 8

        StyledText {
            text: MediaService.icon
            color: MediaService.playing ? Theme.green : Theme.grey1
            font.family: Theme.iconFontFamily
        }

        StyledText {
            width: Math.min(implicitWidth, Settings.mediaMaxWidth - 52)
            text: MediaService.trackText
            color: MediaService.playing ? Theme.fg0 : Theme.grey1
            elide: Text.ElideRight
        }
    }

    onClicked: function(mouse) {
        if (mouse.button === Qt.MiddleButton || mouse.button === Qt.RightButton)
            MediaService.toggle();
        else if (mouse.button === Qt.LeftButton)
            PopupManager.toggle("media", screenName);
    }
    onWheel: wheel => {
        if (wheel.angleDelta.y > 0)
            MediaService.next();
        else
            MediaService.previous();
    }
}
