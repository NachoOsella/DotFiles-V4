pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import "../components"
import "../config"

PopupSurface {
    id: root

    popupName: "calendar"
    surfaceWidth: 380
    property int monthOffset: 0
    readonly property date today: clock.date
    readonly property date displayedMonth: new Date(today.getFullYear(), today.getMonth() + monthOffset, 1)
    readonly property int firstDay: (displayedMonth.getDay() + 6) % 7
    readonly property int daysInMonth: new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + 1, 0).getDate()
    readonly property int weekRows: Math.ceil((firstDay + daysInMonth) / 7)
    readonly property var weekdayNames: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

    function isoWeek(day: date): int {
        const target = new Date(day.getFullYear(), day.getMonth(), day.getDate());
        target.setDate(target.getDate() + 3 - (target.getDay() + 6) % 7);
        const firstThursday = new Date(target.getFullYear(), 0, 4);
        return 1 + Math.round(((target - firstThursday) / 86400000 - 3 + (firstThursday.getDay() + 6) % 7) / 7);
    }

    SystemClock {
        id: clock
        precision: SystemClock.Minutes
    }

    Column {
        width: parent.width
        spacing: 2

        StyledText {
            text: Qt.formatDate(root.today, "dddd")
            color: Theme.grey1
            font.pixelSize: Theme.label
        }

        StyledText {
            text: Qt.formatDate(root.today, "d MMMM yyyy")
            color: Theme.fg1
            font.pixelSize: Theme.title
            font.weight: Font.Bold
        }
    }

    Separator { width: parent.width }

    Item {
        width: parent.width
        height: 30

        StyledText {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: Qt.formatDate(root.displayedMonth, "MMMM yyyy")
            color: Theme.fg0
            font.weight: Font.DemiBold
        }

        Row {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter

            IconButton {
                visible: root.monthOffset !== 0
                icon: "󰃭"
                onClicked: root.monthOffset = 0
            }

            IconButton {
                icon: "󰅁"
                onClicked: root.monthOffset--
            }

            IconButton {
                icon: "󰅂"
                onClicked: root.monthOffset++
            }
        }
    }

    Grid {
        id: calendarGrid

        readonly property real cellWidth: (width - 24) / 7

        width: parent.width
        columns: 8

        StyledText {
            width: 24
            height: 26
            text: "Wk"
            color: Theme.bg4
            font.pixelSize: Theme.caption
        }

        Repeater {
            model: root.weekdayNames

            delegate: StyledText {
                required property int index
                required property string modelData
                width: calendarGrid.cellWidth
                height: 26
                text: modelData
                color: index >= 5 ? Theme.grey0 : Theme.grey1
                font.pixelSize: Theme.caption
                horizontalAlignment: Text.AlignHCenter
            }
        }

        Repeater {
            model: root.weekRows * 8

            delegate: Item {
                id: cell

                required property int index
                readonly property int row: Math.floor(index / 8)
                readonly property int column: index % 8
                readonly property bool weekCell: column === 0
                readonly property int dayNumber: row * 7 + column - root.firstDay
                readonly property bool validDay: !weekCell && dayNumber >= 1 && dayNumber <= root.daysInMonth
                readonly property bool isToday: validDay && root.monthOffset === 0 && dayNumber === root.today.getDate()

                width: weekCell ? 24 : calendarGrid.cellWidth
                height: 36

                Rectangle {
                    anchors.fill: parent
                    anchors.margins: 2
                    visible: cell.isToday
                    color: Theme.accent
                }

                StyledText {
                    anchors.centerIn: parent
                    text: cell.weekCell
                        ? root.isoWeek(new Date(root.displayedMonth.getFullYear(), root.displayedMonth.getMonth(), Math.max(1, cell.row * 7 - root.firstDay + 1)))
                        : cell.validDay ? cell.dayNumber : ""
                    color: cell.weekCell ? Theme.bg4 : cell.isToday ? Theme.bg0 : cell.column >= 6 ? Theme.grey1 : Theme.fg0
                    font.pixelSize: cell.weekCell ? Theme.caption : Theme.body
                    font.weight: cell.isToday ? Font.Bold : Font.Normal
                }
            }
        }
    }

    onShownChanged: monthOffset = 0
}
