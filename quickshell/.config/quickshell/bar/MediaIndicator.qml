import QtQuick
import QtQuick.Layouts
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName
    property real maxWidth: Settings.mediaMaxWidth
    readonly property real textSpace: maxWidth - horizontalPadding * 2 - mediaIcon.width - mediaRow.spacing * 2

    visible: MediaService.available && maxWidth >= 120
    implicitWidth: visible ? Math.min(mediaRow.implicitWidth + horizontalPadding * 2, maxWidth) : 0
    width: implicitWidth
    clip: true
    horizontalPadding: 14
    active: PopupManager.isOpen("media", screenName)

    RowLayout {
        id: mediaRow
        spacing: 9

        Icon {
            id: mediaIcon
            text: MediaService.playing ? MediaService.icon : "󰏤"
            color: MediaService.playing ? Theme.accent : Theme.grey0
        }

        StyledText {
            id: titleText
            // The title keeps priority; the artist takes what is left and disappears when it no longer fits.
            Layout.maximumWidth: root.textSpace * (artistText.visible ? 0.6 : 1)
            text: MediaService.title
            color: MediaService.playing ? Theme.fg0 : Theme.grey1
            font.pixelSize: Theme.body
        }

        StyledText {
            id: artistText
            visible: MediaService.artist.length > 0 && root.textSpace > 260
            Layout.maximumWidth: root.textSpace - titleText.width
            text: MediaService.artist
            color: Theme.grey0
            font.pixelSize: Theme.label
        }
    }

    onClicked: function(mouse) {
        if (mouse.button === Qt.MiddleButton || mouse.button === Qt.RightButton)
            MediaService.toggle();
        else
            PopupManager.toggle("media", screenName);
    }
    // One track change per wheel notch (120 units), even for high-resolution wheels and touchpads.
    property real wheelDelta: 0
    onWheel: wheel => {
        wheelDelta += wheel.angleDelta.y;
        if (Math.abs(wheelDelta) < 120)
            return;
        if (wheelDelta > 0)
            MediaService.previous();
        else
            MediaService.next();
        wheelDelta = 0;
    }
}
