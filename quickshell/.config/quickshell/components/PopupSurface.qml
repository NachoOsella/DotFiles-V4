import QtQuick
import Quickshell
import "../config"
import "../services"

PopupWindow {
    id: root

    default property alias contentData: body.data
    required property Item anchorItem
    required property string popupName
    required property string screenName
    property int surfaceWidth: Settings.popupWidth
    property int contentPadding: 14
    property bool needsKeyboardFocus: false
    property bool pointerEntered: false

    visible: PopupManager.isOpen(popupName, screenName)
    implicitWidth: surfaceWidth
    implicitHeight: body.implicitHeight + contentPadding * 2
    color: Theme.transparent
    grabFocus: needsKeyboardFocus

    anchor.item: anchorItem
    anchor.edges: Edges.Bottom
    anchor.gravity: Edges.Bottom
    anchor.margins.top: Settings.popupMargin
    anchor.adjustment: PopupAdjustment.All

    onVisibleChanged: {
        pointerEntered = false;
        if (visible)
            anchor.updateAnchor();
    }
    onClosed: {
        if (PopupManager.isOpen(popupName, screenName))
            PopupManager.close();
    }

    Rectangle {
        anchors.fill: parent
        color: Theme.popupBackground
        border.width: 1
        border.color: Theme.border
        radius: Settings.popupRadius

        HoverHandler {
            id: popupHover
            onHoveredChanged: {
                if (hovered)
                    root.pointerEntered = true;
            }
        }

        Column {
            id: body
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: root.contentPadding
            spacing: 8
        }
    }

    // Avoid keyboard grabs while still dismissing a popup after deliberate pointer use.
    Timer {
        interval: 700
        running: root.visible
            && root.pointerEntered
            && !popupHover.hovered
            && !(root.anchorItem && root.anchorItem.hovered)
        onTriggered: {
            if (PopupManager.isOpen(root.popupName, root.screenName))
                PopupManager.close();
        }
    }

    Shortcut {
        sequence: "Escape"
        context: Qt.WindowShortcut
        onActivated: PopupManager.close()
    }
}
