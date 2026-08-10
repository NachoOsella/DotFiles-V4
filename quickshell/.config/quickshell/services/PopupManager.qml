pragma Singleton

import QtQuick
import Quickshell

Singleton {
    property string activePopup: ""
    property string activeScreen: ""
    property string pendingPopup: ""
    property string pendingScreen: ""

    function toggle(name: string, screenName: string): void {
        if (activePopup === name && activeScreen === screenName) {
            close();
            return;
        }
        open(name, screenName);
    }

    function open(name: string, screenName: string): void {
        if (activePopup.length > 0) {
            pendingPopup = name;
            pendingScreen = screenName;
            activePopup = "";
            activeScreen = "";
            switchTimer.restart();
            return;
        }
        activePopup = name;
        activeScreen = screenName;
    }

    function close(): void {
        switchTimer.stop();
        pendingPopup = "";
        pendingScreen = "";
        activePopup = "";
        activeScreen = "";
    }

    function isOpen(name: string, screenName: string): bool {
        return activePopup === name && activeScreen === screenName;
    }

    Timer {
        id: switchTimer
        interval: 60
        onTriggered: {
            activePopup = pendingPopup;
            activeScreen = pendingScreen;
            pendingPopup = "";
            pendingScreen = "";
        }
    }
}
