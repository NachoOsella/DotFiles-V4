import QtQuick
import Quickshell
import "../components"
import "../config"

PopupSurface {
    id: root

    popupName: "calendar"
    surfaceWidth: 380
    property int monthOffset: 0
    readonly property date today: new Date()
    readonly property date displayedMonth: new Date(today.getFullYear(), today.getMonth() + monthOffset, 1)
    readonly property int firstDay: (displayedMonth.getDay() + 6) % 7
    readonly property int daysInMonth: new Date(displayedMonth.getFullYear(), displayedMonth.getMonth() + 1, 0).getDate()
    readonly property var weekdayNames: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    SystemClock {
        id: clock
        precision: SystemClock.Minutes
    }

    Column {
        width: parent.width
        spacing: 9

        StyledText {
            width: parent.width
            text: Qt.formatDateTime(clock.date, "dddd, d MMMM yyyy")
            color: Theme.fg1
            font.pixelSize: Settings.smallFontSize
        }

        Row {
            width: parent.width

            IconButton {
                icon: "󰅁"
                onClicked: root.monthOffset--
            }

            StyledText {
                width: parent.width - 64
                horizontalAlignment: Text.AlignHCenter
                text: Qt.formatDate(root.displayedMonth, "MMMM yyyy")
                color: Theme.fg1
                font.pixelSize: Settings.fontSize
                font.weight: Font.Bold
            }

            IconButton {
                icon: "󰅂"
                onClicked: root.monthOffset++
            }
        }

        Grid {
            id: calendarGrid
            width: parent.width
            columns: 7
            columnSpacing: 6
            rowSpacing: 4

            Repeater {
                model: 49

                delegate: Rectangle {
                    required property int index
                    readonly property bool isWeekday: index < 7
                    readonly property int dayNumber: index - 7 - root.firstDay + 1
                    readonly property bool validDay: !isWeekday && dayNumber >= 1 && dayNumber <= root.daysInMonth
                    readonly property bool isToday: validDay
                        && root.monthOffset === 0
                        && dayNumber === root.today.getDate()

                    width: (calendarGrid.width - calendarGrid.columnSpacing * 6) / 7
                    height: 30
                    radius: 4
                    color: isToday ? Theme.statusline2 : Theme.transparent
                    border.width: isToday ? 1 : 0
                    border.color: Theme.green

                    StyledText {
                        anchors.centerIn: parent
                        text: parent.isWeekday ? root.weekdayNames[parent.index] : parent.validDay ? parent.dayNumber : ""
                        color: parent.isWeekday ? Theme.grey1 : parent.isToday ? Theme.green : Theme.fg0
                        font.pixelSize: parent.isWeekday ? 10 : Settings.smallFontSize
                        font.weight: parent.isToday ? Font.Bold : Font.Medium
                    }
                }
            }
        }

        IconButton {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.monthOffset !== 0
            icon: "󰑐"
            label: "Today"
            onClicked: root.monthOffset = 0
        }
    }
}
