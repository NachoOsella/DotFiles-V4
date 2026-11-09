pragma ComponentBehavior: Bound

import QtQuick
import "../components"
import "../config"
import "../services"

// Opens on hover over the memory module instead of through PopupManager.
PopupSurface {
    id: root

    property bool anchorHovered: false
    property bool hoverOpen: false

    surfaceWidth: 380
    shown: hoverOpen

    function setAnchorHovered(hovered: bool): void {
        anchorHovered = hovered;
        if (hovered) {
            closeTimer.stop();
            openTimer.restart();
        } else {
            openTimer.stop();
            closeTimer.restart();
        }
    }

    function hide(): void {
        openTimer.stop();
        closeTimer.stop();
        hoverOpen = false;
    }

    onHoveredChanged: {
        if (hovered)
            closeTimer.stop();
        else if (!anchorHovered)
            closeTimer.restart();
    }

    onShownChanged: {
        if (shown)
            SystemService.refreshTopMemoryPrograms();
    }

    PopupHeader {
        title: "Memory"
        detail: SystemService.formatMemory(SystemService.memoryUsedGiB * 1048576) + " / " + SystemService.formatMemory(SystemService.memoryTotalGiB * 1048576)
    }

    StyledSlider {
        width: parent.width
        value: SystemService.memoryPercentage
        accent: SystemService.memoryPercentage >= Settings.memoryWarningRatio ? Theme.warning : Theme.accent
        showHandle: false
        enabled: true
    }

    Column {
        width: parent.width
        spacing: 0

        Repeater {
            model: SystemService.topMemoryPrograms

            delegate: Item {
                required property int index
                required property var modelData

                width: parent.width
                height: 30

                StyledText {
                    anchors.left: parent.left
                    anchors.right: memoryValue.left
                    anchors.rightMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    text: modelData.name
                    color: index === 0 ? Theme.fg1 : Theme.fg0
                    font.pixelSize: Theme.label
                }

                StyledText {
                    id: memoryValue
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    text: SystemService.formatMemory(modelData.pssKiB)
                    color: Theme.grey1
                    font.pixelSize: Theme.label
                }
            }
        }
    }

    Timer {
        id: openTimer
        interval: 300
        onTriggered: root.hoverOpen = root.anchorHovered
    }

    Timer {
        id: closeTimer
        interval: 500
        onTriggered: {
            if (!root.anchorHovered && !root.hovered)
                root.hoverOpen = false;
        }
    }

    Timer {
        interval: 3000
        repeat: true
        running: root.shown
        onTriggered: SystemService.refreshTopMemoryPrograms()
    }
}
