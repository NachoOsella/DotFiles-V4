pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io
import "../components"
import "../config"
import "../services"

// Clipboard history from cliphist with search and keyboard navigation.
PopupSurface {
    id: root

    popupName: "clipboard"
    surfaceWidth: 500
    needsKeyboardFocus: true
    property int selectedIndex: 0
    readonly property var filtered: {
        const query = searchInput.text.trim().toLowerCase();
        return query.length === 0 ? ClipboardService.entries
            : ClipboardService.entries.filter(entry => entry.text.toLowerCase().includes(query));
    }

    function choose(entry: var): void {
        if (!entry)
            return;
        ClipboardService.restore(entry);
        PopupManager.close();
    }

    PopupHeader {
        title: "Clipboard"
        detail: ClipboardService.entries.length > 0 ? ClipboardService.entries.length.toString() : ""

        IconButton {
            visible: ClipboardService.entries.length > 0
            icon: "󰎟"
            onClicked: ClipboardService.clear()
        }
    }

    Rectangle {
        width: parent.width
        height: 38
        color: Theme.bg0
        border.width: 1
        border.color: searchInput.activeFocus ? Theme.accent : Theme.border

        Icon {
            id: searchIcon
            anchors.left: parent.left
            anchors.leftMargin: 10
            anchors.verticalCenter: parent.verticalCenter
            text: "󰍉"
            color: Theme.grey0
        }

        TextInput {
            id: searchInput
            anchors.left: searchIcon.right
            anchors.leftMargin: 10
            anchors.right: parent.right
            anchors.rightMargin: 10
            anchors.verticalCenter: parent.verticalCenter
            color: Theme.fg1
            selectionColor: Theme.bg4
            font.family: Theme.fontFamily
            font.pixelSize: Theme.body
            clip: true
            onTextChanged: root.selectedIndex = 0
            onAccepted: root.choose(root.filtered[root.selectedIndex])
            Keys.onDownPressed: root.selectedIndex = Math.min(root.filtered.length - 1, root.selectedIndex + 1)
            Keys.onUpPressed: root.selectedIndex = Math.max(0, root.selectedIndex - 1)
            Keys.onPressed: event => {
                if (event.key === Qt.Key_Delete && root.filtered[root.selectedIndex]) {
                    ClipboardService.remove(root.filtered[root.selectedIndex]);
                    event.accepted = true;
                }
            }

            StyledText {
                visible: searchInput.text.length === 0
                anchors.verticalCenter: parent.verticalCenter
                text: "Search"
                color: Theme.grey0
            }
        }
    }

    StyledText {
        visible: root.filtered.length === 0
        width: parent.width
        height: 60
        text: ClipboardService.loading ? "Loading" : "Empty"
        color: Theme.grey0
        horizontalAlignment: Text.AlignHCenter
    }

    ListView {
        id: list
        visible: root.filtered.length > 0
        width: parent.width
        height: Math.min(420, contentHeight)
        model: root.filtered
        currentIndex: root.selectedIndex
        clip: true
        spacing: 2
        boundsBehavior: Flickable.StopAtBounds
        highlightMoveDuration: 0

        delegate: Rectangle {
            id: item

            required property int index
            required property var modelData
            readonly property bool current: index === root.selectedIndex

            width: list.width
            height: modelData.image ? 76 : 38
            color: current ? Theme.hover : pointer.containsMouse ? Theme.raised : Theme.transparent

            Rectangle {
                visible: item.current
                width: 2
                height: parent.height
                color: Theme.accent
            }

            Image {
                id: preview
                visible: item.modelData.image
                anchors.left: parent.left
                anchors.leftMargin: 12
                anchors.verticalCenter: parent.verticalCenter
                width: 88
                height: 60
                fillMode: Image.PreserveAspectFit
                asynchronous: true
                sourceSize.width: 176
                sourceSize.height: 120
                source: ""

                Component.onCompleted: {
                    if (item.modelData.image)
                        decoder.running = true;
                }
            }

            Process {
                id: decoder
                command: ["sh", "-c", "[ -s \"$2\" ] || printf '%s' \"$1\" | cliphist decode > \"$2\"", "sh", item.modelData.id, item.modelData.previewPath]
                onExited: exitCode => {
                    if (exitCode === 0)
                        preview.source = "file://" + item.modelData.previewPath;
                }
            }

            StyledText {
                anchors.left: item.modelData.image ? preview.right : parent.left
                anchors.leftMargin: 12
                anchors.right: parent.right
                anchors.rightMargin: 12
                anchors.verticalCenter: parent.verticalCenter
                text: item.modelData.text
                color: item.modelData.image ? Theme.grey1 : item.current ? Theme.fg1 : Theme.fg0
                font.pixelSize: item.modelData.image ? Theme.label : Theme.body
            }

            MouseArea {
                id: pointer
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                cursorShape: Qt.PointingHandCursor
                onClicked: mouse => {
                    if (mouse.button === Qt.MiddleButton)
                        ClipboardService.remove(item.modelData);
                    else
                        root.choose(item.modelData);
                }
            }
        }
    }

    StyledText {
        width: parent.width
        text: "Enter paste  ·  Del remove  ·  Esc close"
        color: Theme.bg4
        font.pixelSize: Theme.caption
        horizontalAlignment: Text.AlignHCenter
    }

    onShownChanged: {
        if (shown) {
            searchInput.text = "";
            selectedIndex = 0;
            ClipboardService.refresh();
            searchInput.forceActiveFocus();
        }
    }
}
