import QtQuick
import Quickshell
import "../components"
import "../config"

ModuleButton {
    implicitWidth: Settings.barHeight + 6

    Icon {
        text: "\uf303"
        color: Theme.accent
        font.pixelSize: Theme.iconLarge
    }

    onClicked: Quickshell.execDetached(Settings.launcherCommand)
}
