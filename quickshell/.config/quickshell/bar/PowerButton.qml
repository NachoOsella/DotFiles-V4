import QtQuick
import "../components"
import "../config"
import "../services"

ModuleButton {
    id: root

    required property string screenName

    implicitWidth: Settings.barHeight + 4
    active: PopupManager.isOpen("power", screenName)

    Icon {
        text: "\uf011"
        color: root.hovered || root.active ? Theme.critical : Theme.grey1
    }

    onClicked: PopupManager.toggle("power", screenName)
}
