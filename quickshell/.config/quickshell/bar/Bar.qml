import QtQuick
import Quickshell
import Quickshell.Wayland
import "../components"
import "../config"
import "../popups"
import "../services"

PanelWindow {
    id: root

    readonly property string screenName: screen.name
    readonly property int groupGap: 16
    // Widest centered module that still clears both side groups; shrinks as the logical width drops at higher scales.
    readonly property real centerSpace: Math.max(0, 2 * Math.min(width / 2 - leftFixed.width - groupGap, rightModules.x - width / 2 - groupGap))

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
    WlrLayershell.namespace: "quickshell:bar"

    Rectangle {
        anchors.fill: parent
        color: Theme.barBackground

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: Theme.border
        }
    }

    Row {
        id: leftFixed
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom

        LauncherButton { }
        Workspaces { }
    }

    // Anchor for popups opened from shortcuts rather than from a bar module.
    Item {
        id: centerAnchor
        anchors.horizontalCenter: parent.horizontalCenter
        width: 1
        height: parent.height
    }

    MediaIndicator {
        id: mediaIndicator
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        screenName: root.screenName
        maxWidth: Math.min(Settings.mediaMaxWidth, root.centerSpace)
    }

    Row {
        id: rightModules
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom

        StatusIndicators { }
        Tray { barWindow: root }
        Separator { vertical: true; height: parent.height }
        NetworkIndicator { id: networkIndicator; screenName: root.screenName }
        AudioIndicator { id: audioIndicator; screenName: root.screenName }
        MemoryIndicator { id: memoryIndicator; memoryPopup: memoryPopup }
        BatteryIndicator { id: batteryIndicator; screenName: root.screenName }
        Separator { vertical: true; height: parent.height }
        Clock { id: clockIndicator; screenName: root.screenName }
        PowerButton { id: powerIndicator; screenName: root.screenName }
    }

    MemoryPopup { id: memoryPopup; anchorItem: memoryIndicator }
    MediaPopup { anchorItem: mediaIndicator; screenName: root.screenName }
    AudioPopup { anchorItem: audioIndicator; screenName: root.screenName }
    NetworkPopup { anchorItem: networkIndicator; screenName: root.screenName }
    BluetoothPopup { anchorItem: batteryIndicator; screenName: root.screenName }
    ControlCenter { anchorItem: batteryIndicator; screenName: root.screenName }
    CalendarPopup { anchorItem: clockIndicator; screenName: root.screenName }
    NotificationCenter { anchorItem: clockIndicator; screenName: root.screenName }
    ClipboardPopup { anchorItem: clockIndicator; screenName: root.screenName }
    CalculatorPopup { anchorItem: centerAnchor; screenName: root.screenName }
    PowerMenu { anchorItem: powerIndicator; screenName: root.screenName }
}
