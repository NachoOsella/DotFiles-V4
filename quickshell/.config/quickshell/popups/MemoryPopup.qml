import QtQuick
import Quickshell
import "../components"
import "../config"
import "../services"

PopupWindow {
    id: root

    required property Item anchorItem
    property bool anchorHovered: false
    property bool popupHovered: false
    property bool popupVisible: false

    implicitWidth: 360
    implicitHeight: content.implicitHeight + 28
    visible: popupVisible
    color: Theme.transparent
    grabFocus: false

    anchor.item: anchorItem
    anchor.edges: Edges.Bottom
    anchor.gravity: Edges.Bottom
    anchor.margins.top: Settings.popupMargin
    anchor.adjustment: PopupAdjustment.All

    function setAnchorHovered(hovered: bool): void {
        anchorHovered = hovered;
        if (hovered) {
            closeTimer.stop();
            openTimer.restart();
        } else {
            openTimer.stop();
            if (!popupHovered)
                closeTimer.restart();
        }
    }

    function hide(): void {
        openTimer.stop();
        closeTimer.stop();
        popupVisible = false;
    }

    onVisibleChanged: {
        if (visible) {
            anchor.updateAnchor();
            SystemService.refreshTopMemoryPrograms();
            refreshTimer.restart();
        } else {
            refreshTimer.stop();
        }
    }

    Rectangle {
        anchors.fill: parent
        color: Theme.popupBackground
        border.width: 1
        border.color: Theme.border
        radius: Settings.popupRadius

        HoverHandler {
            onHoveredChanged: {
                root.popupHovered = hovered;
                if (hovered)
                    closeTimer.stop();
                else if (!root.anchorHovered)
                    closeTimer.restart();
            }
        }

        Column {
            id: content

            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: 14
            spacing: 6

            Item {
                width: parent.width
                height: Math.max(memoryIcon.implicitHeight, memoryTitle.implicitHeight, memorySummary.implicitHeight)

                StyledText {
                    id: memoryIcon

                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    text: ""
                    color: Theme.grey2
                    font.family: Theme.iconFontFamily
                }

                StyledText {
                    id: memoryTitle

                    anchors.left: memoryIcon.right
                    anchors.leftMargin: 8
                    anchors.right: memorySummary.left
                    anchors.rightMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Top memory usage"
                    color: Theme.fg1
                    font.pixelSize: Settings.smallFontSize + 1
                    font.weight: Font.Bold
                    elide: Text.ElideRight
                }

                StyledText {
                    id: memorySummary

                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    text: SystemService.formatMemory(SystemService.memoryUsedGiB * 1024 * 1024)
                        + " / " + SystemService.formatMemory(SystemService.memoryTotalGiB * 1024 * 1024)
                    color: Theme.grey1
                    font.pixelSize: Settings.smallFontSize - 2
                }
            }

            Separator { width: parent.width }

            Repeater {
                model: SystemService.topMemoryPrograms

                delegate: Item {
                    required property int index
                    required property var modelData

                    width: parent.width
                    height: 27

                    StyledText {
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        width: 24
                        text: (index + 1).toString()
                        color: Theme.grey1
                        font.pixelSize: Settings.smallFontSize - 2
                    }

                    StyledText {
                        anchors.left: parent.left
                        anchors.leftMargin: 24
                        anchors.right: memoryValue.left
                        anchors.rightMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        text: modelData.name
                        color: Theme.fg0
                        font.pixelSize: Settings.smallFontSize
                        elide: Text.ElideRight
                    }

                    StyledText {
                        id: memoryValue

                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        text: SystemService.formatMemory(modelData.rssKiB)
                        color: Theme.aqua
                        font.pixelSize: Settings.smallFontSize - 1
                    }
                }
            }

            StyledText {
                visible: SystemService.memoryProgramsBusy
                width: parent.width
                text: "Reading processes..."
                color: Theme.grey1
                font.pixelSize: Settings.smallFontSize
            }

            StyledText {
                visible: !SystemService.memoryProgramsBusy && SystemService.topMemoryPrograms.length === 0
                width: parent.width
                text: "No memory data available"
                color: Theme.grey1
                font.pixelSize: Settings.smallFontSize
            }
        }
    }

    Timer {
        id: openTimer

        interval: 300
        onTriggered: {
            if (root.anchorHovered)
                root.popupVisible = true;
        }
    }

    Timer {
        id: closeTimer

        interval: 600
        onTriggered: {
            if (!root.anchorHovered && !root.popupHovered)
                root.popupVisible = false;
        }
    }

    Timer {
        id: refreshTimer

        interval: 3000
        repeat: true
        running: root.visible
        onTriggered: SystemService.refreshTopMemoryPrograms()
    }
}
