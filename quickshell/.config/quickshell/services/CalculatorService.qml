pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

// Evaluates expressions with qalc, so units, currencies, and functions work as in rofi-calc.
Singleton {
    id: root

    property string expression: ""
    property string preview: ""
    property var history: []
    readonly property int historyLimit: 6

    function append(text: string): void {
        expression += text;
    }

    function backspace(): void {
        expression = expression.slice(0, -1);
    }

    function clear(): void {
        expression = "";
        preview = "";
    }

    function commit(): void {
        if (preview.length === 0)
            return;
        history = [{ expression: expression, result: preview }].concat(history).slice(0, historyLimit);
        expression = preview;
        preview = "";
    }

    function copy(text: string): void {
        Quickshell.execDetached(["wl-copy", "--", text]);
    }

    onExpressionChanged: debounce.restart()

    IpcHandler {
        target: "calculator"

        function evaluate(text: string): void {
            root.expression = text;
        }
    }

    Timer {
        id: debounce
        interval: 120
        onTriggered: {
            const trimmed = root.expression.trim();
            // Without digits qalc reads stray words as units ("foo" becomes femtobar), so skip those.
            if (!/\d/.test(trimmed)) {
                root.preview = "";
                return;
            }
            evaluator.running = false;
            evaluator.command = ["qalc", "-t", "-set", "upxrates 0", trimmed];
            evaluator.running = true;
        }
    }

    Process {
        id: evaluator
        stdout: StdioCollector { id: evaluatorOutput }
        onExited: exitCode => {
            const result = evaluatorOutput.text.trim();
            // qalc echoes unparsable input back; hide results identical to the expression.
            root.preview = exitCode === 0 && result.length > 0 && result !== root.expression.trim() ? result : "";
        }
    }
}
