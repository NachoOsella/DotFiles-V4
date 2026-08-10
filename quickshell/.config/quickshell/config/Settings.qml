pragma Singleton

import Quickshell

Singleton {
    readonly property int barHeight: 38
    readonly property int moduleHeight: barHeight
    readonly property int fontSize: 17
    readonly property int smallFontSize: 15
    readonly property int activeWindowMaxWidth: 310
    readonly property int mediaMaxWidth: 500
    readonly property int popupWidth: 410
    readonly property int popupMargin: 7
    readonly property int popupRadius: 4
    readonly property int animationFast: 140
    readonly property int animationNormal: 180
    readonly property int workspaceCount: 7
    readonly property int volumeStep: 5
    readonly property string clockTimeZone: "America/Argentina/Cordoba"
    readonly property bool notificationServerEnabled: true
    readonly property bool powerProfilesAvailable: false
    readonly property string rofiCommand: "rofi"
    readonly property list<string> rofiArguments: ["-show", "drun", "-theme", Quickshell.env("HOME") + "/.config/rofi/config.rasi"]
}
