import QtQuick
import Quickshell
import "../components"
import "../config"
import "../popups"
import "../services"

PanelWindow {
    id: root

    anchors {
        top: true
        left: true
        right: true
    }
    implicitHeight: Settings.barHeight
    exclusiveZone: Settings.barHeight
    aboveWindows: true
    focusable: false
    color: Theme.transparent

    Rectangle {
        anchors.fill: parent
        color: Theme.barBackground

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: Theme.bg3
        }
    }

    Row {
        id: leftModules
        anchors.left: parent.left
        anchors.leftMargin: 6
        anchors.verticalCenter: parent.verticalCenter
        height: Settings.barHeight

        LauncherButton { }
        Workspaces { }
        ActiveWindow { screenInfo: root.screen }
    }

    MediaIndicator {
        id: centeredMedia
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.verticalCenter: parent.verticalCenter
        height: Settings.barHeight
        screenName: root.screen.name
    }

    Row {
        id: rightModules
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        height: Settings.barHeight

        Separator { vertical: true; height: parent.height }
        NetworkIndicator { id: networkIndicator; screenName: root.screen.name }
        AudioIndicator { id: audioIndicator; screenName: root.screen.name }
        MemoryIndicator { }
        BatteryIndicator { id: batteryIndicator; screenName: root.screen.name }
        Separator { vertical: true; height: parent.height; visible: tray.visible }
        Tray { id: tray; barWindow: root }
        Separator { vertical: true; height: parent.height }
        Clock { id: clockIndicator; screenName: root.screen.name }
        Separator { vertical: true; height: parent.height }
        PowerButton { id: powerIndicator; screenName: root.screen.name }
    }

    MediaPopup {
        anchorItem: centeredMedia
        screenName: root.screen.name
    }

    AudioPopup {
        anchorItem: audioIndicator
        screenName: root.screen.name
    }

    NetworkPopup {
        anchorItem: networkIndicator
        screenName: root.screen.name
    }

    BluetoothPopup {
        anchorItem: batteryIndicator
        screenName: root.screen.name
    }

    ControlCenter {
        anchorItem: batteryIndicator
        screenName: root.screen.name
    }

    CalendarPopup {
        anchorItem: clockIndicator
        screenName: root.screen.name
    }

    NotificationCenter {
        anchorItem: clockIndicator
        screenName: root.screen.name
    }

    PowerMenu {
        anchorItem: powerIndicator
        screenName: root.screen.name
    }
}
