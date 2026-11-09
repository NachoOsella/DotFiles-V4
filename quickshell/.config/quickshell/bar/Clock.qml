import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    horizontalPadding: 12
    active: PopupManager.isOpen("calendar", screenName) || PopupManager.isOpen("notifications", screenName)

    SystemClock {
        id: clock
        precision: SystemClock.Minutes
    }

    StyledText {
        text: Qt.formatDateTime(clock.date, "ddd d")
        color: Theme.grey1
        font.pixelSize: Theme.body
    }

    StyledText {
        text: Qt.formatDateTime(clock.date, "HH:mm")
        color: Theme.fg1
        font.pixelSize: Theme.body
        font.weight: Font.Bold
    }

    // Unread notifications or Do Not Disturb.
    Icon {
        visible: NotificationService.doNotDisturb || NotificationService.count > 0
        text: NotificationService.doNotDisturb ? "󰂛" : "󰂚"
        color: NotificationService.doNotDisturb ? Theme.grey0 : Theme.accent
        font.pixelSize: Theme.label
    }

    onClicked: function(mouse) {
        if (mouse.button === Qt.RightButton || mouse.button === Qt.MiddleButton)
            PopupManager.toggle("notifications", screenName);
        else
            PopupManager.toggle("calendar", screenName);
    }
}
