pragma Singleton

import QtQuick
import Quickshell

// Gruvbox Material Dark Hard. Green is the only accent; yellow and red mean warning and critical.
Singleton {
    readonly property string fontFamily: "JetBrainsMono Nerd Font"
    readonly property string iconFontFamily: "Symbols Nerd Font"

    // Surfaces, darkest to lightest.
    readonly property color bgDim: "#141617"
    readonly property color bg0: "#1d2021"
    readonly property color bg1: "#282828"
    readonly property color bg2: "#32302f"
    readonly property color bg3: "#3c3836"
    readonly property color bg4: "#504945"

    // Text, strongest to weakest.
    readonly property color fg1: "#ddc7a1"
    readonly property color fg0: "#d4be98"
    readonly property color grey2: "#a89984"
    readonly property color grey1: "#928374"
    readonly property color grey0: "#7c6f64"

    readonly property color accent: "#a9b665"
    readonly property color warning: "#d8a657"
    readonly property color critical: "#ea6962"

    readonly property color transparent: "transparent"
    readonly property color barBackground: Qt.rgba(29 / 255, 32 / 255, 33 / 255, 0.88)
    readonly property color surface: Qt.rgba(29 / 255, 32 / 255, 33 / 255, 0.94)
    readonly property color raised: bg1
    readonly property color hover: bg2
    readonly property color pressed: bg3
    readonly property color border: bg3

    // Type scale in logical pixels.
    readonly property int caption: 12
    readonly property int label: 15
    readonly property int body: 16
    readonly property int title: 18
    readonly property int display: 32
    readonly property int icon: 18
    readonly property int iconLarge: 22
}
