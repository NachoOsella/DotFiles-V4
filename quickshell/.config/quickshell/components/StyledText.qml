import QtQuick
import "../config"

Text {
    color: Theme.fg0
    font.family: Theme.fontFamily
    font.pixelSize: Settings.fontSize
    font.weight: Font.DemiBold
    renderType: Text.NativeRendering
    verticalAlignment: Text.AlignVCenter
    elide: Text.ElideRight
}
