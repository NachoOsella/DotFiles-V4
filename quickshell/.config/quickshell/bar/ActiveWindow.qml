import QtQuick
import Quickshell.Hyprland
import "../components"
import "../config"

Item {
    id: root

    required property var screenInfo
    readonly property var monitor: Hyprland.monitorFor(screenInfo)
    readonly property var workspace: monitor ? monitor.activeWorkspace : null
    readonly property var toplevel: selectToplevel()
    readonly property string title: toplevel ? toplevel.title.trim() : ""

    visible: title.length > 0
    implicitWidth: visible ? Math.min(titleMetrics.advanceWidth + 22, Settings.activeWindowMaxWidth) : 0
    implicitHeight: Settings.barHeight

    TextMetrics {
        id: titleMetrics
        font: titleText.font
        text: root.title
    }

    function selectToplevel(): var {
        if (!workspace)
            return null;
        const windows = workspace.toplevels.values;
        for (const candidate of windows) {
            if (candidate.activated)
                return candidate;
        }
        if (windows.length === 0)
            return null;
        return windows.slice().sort((a, b) => {
            const aHistory = Number(a.lastIpcObject.focusHistoryID ?? 999999);
            const bHistory = Number(b.lastIpcObject.focusHistoryID ?? 999999);
            return aHistory - bHistory;
        })[0];
    }

    StyledText {
        id: titleText
        anchors.fill: parent
        anchors.leftMargin: 11
        anchors.rightMargin: 11
        text: root.title
        color: Theme.grey2
        font.pixelSize: 15
        elide: Text.ElideRight
    }
}
