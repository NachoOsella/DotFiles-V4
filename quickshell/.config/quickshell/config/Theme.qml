pragma Singleton

import QtQuick
import Quickshell

Singleton {
    readonly property string fontFamily: "JetBrainsMono Nerd Font"
    readonly property string iconFontFamily: "Symbols Nerd Font"

    readonly property color bgDim: "#141617"
    readonly property color bg0: "#1d2021"
    readonly property color bg1: "#282828"
    readonly property color bg2: "#282828"
    readonly property color bg3: "#3c3836"
    readonly property color bg4: "#3c3836"
    readonly property color bg5: "#504945"

    readonly property color statusline1: "#282828"
    readonly property color statusline2: "#32302f"
    readonly property color statusline3: "#504945"

    readonly property color fg0: "#d4be98"
    readonly property color fg1: "#ddc7a1"
    readonly property color grey0: "#7c6f64"
    readonly property color grey1: "#928374"
    readonly property color grey2: "#a89984"

    readonly property color red: "#ea6962"
    readonly property color orange: "#e78a4e"
    readonly property color yellow: "#d8a657"
    readonly property color green: "#a9b665"
    readonly property color aqua: "#89b482"
    readonly property color blue: "#7daea3"
    readonly property color purple: "#d3869b"

    readonly property color transparent: "transparent"
    readonly property color barBackground: Qt.rgba(29 / 255, 32 / 255, 33 / 255, 0.96)
    readonly property color popupBackground: bg1
    readonly property color hoverBackground: statusline2
    readonly property color border: bg3
}
