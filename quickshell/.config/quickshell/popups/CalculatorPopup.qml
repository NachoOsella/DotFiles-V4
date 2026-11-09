pragma ComponentBehavior: Bound

import QtQuick
import "../components"
import "../config"
import "../services"

// Pointer-first calculator. Typing still works, and qalc handles units and currencies.
PopupSurface {
    id: root

    popupName: "calculator"
    surfaceWidth: 360
    needsKeyboardFocus: true

    readonly property var keys: [
        { label: "C", value: "clear", kind: "action" },
        { label: "(", value: "(", kind: "operator" },
        { label: ")", value: ")", kind: "operator" },
        { label: "÷", value: "/", kind: "operator" },
        { label: "7", value: "7" }, { label: "8", value: "8" }, { label: "9", value: "9" },
        { label: "×", value: "*", kind: "operator" },
        { label: "4", value: "4" }, { label: "5", value: "5" }, { label: "6", value: "6" },
        { label: "−", value: "-", kind: "operator" },
        { label: "1", value: "1" }, { label: "2", value: "2" }, { label: "3", value: "3" },
        { label: "+", value: "+", kind: "operator" },
        { label: "%", value: "%", kind: "operator" },
        { label: "0", value: "0" },
        { label: ".", value: "." },
        { label: "=", value: "commit", kind: "accent" }
    ]

    function press(key: var): void {
        if (key.value === "clear")
            CalculatorService.clear();
        else if (key.value === "commit")
            CalculatorService.commit();
        else
            CalculatorService.append(key.value);
        input.forceActiveFocus();
    }

    PopupHeader {
        title: "Calculator"

        IconButton {
            icon: "󰆏"
            enabled: CalculatorService.preview.length > 0 || CalculatorService.expression.length > 0
            onClicked: CalculatorService.copy(CalculatorService.preview || CalculatorService.expression)
        }
    }

    // Display: expression on top, live result below.
    Rectangle {
        width: parent.width
        height: 88
        color: Theme.bg0
        border.width: 1
        border.color: input.activeFocus ? Theme.accent : Theme.border

        TextInput {
            id: input
            anchors.left: parent.left
            anchors.right: backspace.left
            anchors.top: parent.top
            anchors.margins: 12
            text: CalculatorService.expression
            color: Theme.fg1
            selectionColor: Theme.bg4
            font.family: Theme.fontFamily
            font.pixelSize: Theme.title
            horizontalAlignment: TextInput.AlignRight
            clip: true
            onTextEdited: CalculatorService.expression = text
            onAccepted: CalculatorService.commit()
            Keys.onEscapePressed: PopupManager.close()
        }

        IconButton {
            id: backspace
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: 6
            icon: "󰭜"
            enabled: CalculatorService.expression.length > 0
            onClicked: {
                CalculatorService.backspace();
                input.forceActiveFocus();
            }
        }

        StyledText {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.margins: 12
            horizontalAlignment: Text.AlignRight
            text: CalculatorService.preview.length > 0 ? "= " + CalculatorService.preview : ""
            color: Theme.accent
            font.pixelSize: Theme.display
            font.weight: Font.Bold
            fontSizeMode: Text.HorizontalFit
            minimumPixelSize: Theme.body

            MouseArea {
                anchors.fill: parent
                enabled: CalculatorService.preview.length > 0
                cursorShape: Qt.PointingHandCursor
                onClicked: CalculatorService.copy(CalculatorService.preview)
            }
        }
    }

    Grid {
        id: keypad
        width: parent.width
        columns: 4
        spacing: 6

        readonly property real keyWidth: (width - spacing * (columns - 1)) / columns

        Repeater {
            model: root.keys

            delegate: Rectangle {
                id: key

                required property var modelData
                readonly property bool accent: modelData.kind === "accent"
                readonly property bool operator: modelData.kind === "operator" || modelData.kind === "action"

                width: keypad.keyWidth
                height: 48
                color: accent ? (pointer.pressed ? Theme.bg3 : pointer.containsMouse ? Theme.bg2 : Theme.bg1)
                    : pointer.pressed ? Theme.pressed : pointer.containsMouse ? Theme.hover : operator ? Theme.bg0 : Theme.raised
                border.width: 1
                border.color: accent ? Theme.accent : pointer.containsMouse ? Theme.bg4 : Theme.border

                Behavior on color {
                    ColorAnimation { duration: Settings.animationFast }
                }

                StyledText {
                    anchors.centerIn: parent
                    text: key.modelData.label
                    color: key.accent ? Theme.accent : key.operator ? Theme.grey2 : Theme.fg1
                    font.pixelSize: Theme.title
                    font.weight: key.accent ? Font.Bold : Font.Normal
                }

                MouseArea {
                    id: pointer
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.press(key.modelData)
                }
            }
        }
    }

    // Recent results; clicking one reuses it.
    Column {
        visible: CalculatorService.history.length > 0
        width: parent.width
        spacing: 2

        SectionLabel { text: "History"; bottomPadding: 4 }

        Repeater {
            model: CalculatorService.history

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                label: modelData.expression
                detail: "= " + modelData.result
                interactive: true
                onClicked: {
                    CalculatorService.expression = modelData.result;
                    input.forceActiveFocus();
                }
            }
        }
    }

    onShownChanged: {
        if (shown)
            input.forceActiveFocus();
    }
}
