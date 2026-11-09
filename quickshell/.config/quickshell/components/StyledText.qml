import QtQuick
import QtQuick.Layouts
import "../config"

Text {
    color: Theme.fg0
    font.family: Theme.fontFamily
    font.pixelSize: Theme.body
    font.weight: Font.Normal
    font.features: { "tnum": 1 }
    renderType: Text.NativeRendering
    verticalAlignment: Text.AlignVCenter
    elide: Text.ElideRight
    Layout.alignment: Qt.AlignBaseline
}
