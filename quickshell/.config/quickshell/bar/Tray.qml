import QtQuick
import Quickshell
import Quickshell.Services.SystemTray
import Quickshell.Widgets
import "../components"
import "../config"

Item {
    id: root

    required property var barWindow

    implicitWidth: trayRow.implicitWidth > 0 ? trayRow.implicitWidth + 20 : 0
    implicitHeight: Settings.barHeight
    visible: SystemTray.items.values.length > 0

    Row {
        id: trayRow
        anchors.centerIn: parent
        spacing: 6

        Repeater {
            model: SystemTray.items

            delegate: Item {
                id: trayDelegate

                required property var modelData
                width: 18
                height: 18

                IconImage {
                    anchors.fill: parent
                    source: trayDelegate.modelData.icon
                }

                MouseArea {
                    id: pointer
                    anchors.fill: parent
                    hoverEnabled: true
                    acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
                    cursorShape: Qt.PointingHandCursor
                    onClicked: function(mouse) {
                        if (mouse.button === Qt.MiddleButton) {
                            trayDelegate.modelData.secondaryActivate();
                            return;
                        }
                        if ((mouse.button === Qt.RightButton || trayDelegate.modelData.onlyMenu) && trayDelegate.modelData.hasMenu) {
                            const position = trayDelegate.mapToItem(root.barWindow.contentItem, mouse.x, mouse.y);
                            trayDelegate.modelData.display(root.barWindow, Math.round(position.x), Math.round(position.y));
                            return;
                        }
                        trayDelegate.modelData.activate();
                    }
                    onWheel: wheel => trayDelegate.modelData.scroll(wheel.angleDelta.y, false)
                }
            }
        }
    }
}
