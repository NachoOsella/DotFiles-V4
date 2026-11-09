import QtQuick
import QtQuick.Layouts
import "../config"

// Text that reserves the width of a template string so changing values never shift the bar.
StyledText {
    id: root

    property string reserve: "100%"

    Layout.preferredWidth: metrics.advanceWidth
    horizontalAlignment: Text.AlignRight
    elide: Text.ElideNone

    TextMetrics {
        id: metrics
        font: root.font
        text: root.reserve
    }
}
