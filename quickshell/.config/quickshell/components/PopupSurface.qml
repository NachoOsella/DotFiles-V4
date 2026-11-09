import QtQuick
import Quickshell
import Quickshell.Hyprland
import "../config"
import "../services"

PopupWindow {
    id: root

    default property alias contentData: body.data
    required property Item anchorItem
    property string popupName: ""
    property string screenName: ""
    property bool shown: PopupManager.isOpen(popupName, screenName)
    property int surfaceWidth: Settings.popupWidth
    property int contentPadding: Settings.popupPadding
    property bool needsKeyboardFocus: false
    property bool pointerEntered: false
    property real progress: shown ? 1 : 0
    readonly property alias hovered: popupHover.hovered

    // Stay mapped until the fade-out finishes.
    visible: progress > 0
    implicitWidth: surfaceWidth
    implicitHeight: body.implicitHeight + contentPadding * 2 + 2
    color: Theme.transparent

    anchor.item: anchorItem
    anchor.edges: Edges.Bottom
    anchor.gravity: Edges.Bottom
    anchor.margins.top: Settings.popupMargin
    anchor.adjustment: PopupAdjustment.All

    Behavior on progress {
        NumberAnimation { duration: Settings.animationFast; easing.type: Easing.OutCubic }
    }

    onShownChanged: {
        pointerEntered = false;
        if (shown)
            anchor.updateAnchor();
    }
    onClosed: {
        if (popupName.length > 0 && PopupManager.isOpen(popupName, screenName))
            PopupManager.close();
    }

    Rectangle {
        id: frame
        width: parent.width
        height: parent.height
        y: (1 - root.progress) * -6
        opacity: root.progress
        color: Theme.surface
        border.width: 1
        border.color: Theme.border

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            height: 2
            color: Theme.accent
        }

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
            anchors.topMargin: root.contentPadding + 2
            spacing: 10
        }
    }

    // Hyprland's focus grab gives the popup keyboard input even when it was opened from a shortcut,
    // where Qt's xdg_popup grab fails because the bar never received input. Clicking outside clears it.
    HyprlandFocusGrab {
        active: root.needsKeyboardFocus && root.shown
        windows: [root]
        onCleared: {
            if (root.popupName.length > 0 && PopupManager.isOpen(root.popupName, root.screenName))
                PopupManager.close();
        }
    }

    // Dismiss after deliberate pointer use without grabbing the keyboard.
    Timer {
        interval: 700
        running: root.shown
            && root.popupName.length > 0
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
