pragma ComponentBehavior: Bound

import QtQuick
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "network"
    surfaceWidth: 460
    needsKeyboardFocus: true
    property var pendingNetwork: null
    property string connectionError: ""
    readonly property var sortedNetworks: NetworkService.networks.slice().sort((a, b) => {
        if (a.connected !== b.connected)
            return a.connected ? -1 : 1;
        return b.signalStrength - a.signalStrength;
    }).slice(0, 8)

    function activateNetwork(network: var): void {
        if (!network)
            return;
        connectionError = "";
        if (network.connected || network.known || network.type === "open") {
            pendingNetwork = null;
            NetworkService.connectNetwork(network, "");
        } else {
            pendingNetwork = network;
            passwordInput.text = "";
            passwordInput.forceActiveFocus();
        }
    }

    PopupHeader {
        title: "Network"
        detail: NetworkService.connected && NetworkService.downloadBitsPerSecond > 0
            ? "↓ " + NetworkService.formatRate(NetworkService.downloadBitsPerSecond) + "  ↑ " + NetworkService.formatRate(NetworkService.uploadBitsPerSecond)
            : ""

        IconButton {
            icon: "󰑓"
            enabled: NetworkService.wifiEnabled
            onClicked: NetworkService.refreshScan()
        }

        IconButton {
            icon: NetworkService.wifiEnabled ? "󰖩" : "󰖪"
            selected: NetworkService.wifiEnabled
            enabled: NetworkService.wifiAvailable
            onClicked: NetworkService.toggleWifi()
        }
    }

    PopupRow {
        width: parent.width
        icon: NetworkService.wiredConnected ? "󰈀" : NetworkService.wifiIcon(NetworkService.signalStrength)
        iconColor: NetworkService.connected ? Theme.accent : Theme.critical
        label: NetworkService.connectionLabel
        detail: NetworkService.connected ? NetworkService.address : ""
    }

    StyledText {
        visible: root.connectionError.length > 0
        width: parent.width
        text: root.connectionError
        color: Theme.warning
        font.pixelSize: Theme.label
        wrapMode: Text.Wrap
    }

    Column {
        width: parent.width
        spacing: 2

        SectionLabel { text: "Wi-Fi"; bottomPadding: 4 }

        StyledText {
            visible: !NetworkService.wifiAvailable || !NetworkService.wifiEnabled
            width: parent.width
            height: 38
            text: !NetworkService.wifiAvailable ? "Wi-Fi unavailable" : "Wi-Fi is off"
            color: Theme.grey0
        }

        Repeater {
            model: NetworkService.wifiEnabled ? root.sortedNetworks : []

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: NetworkService.wifiIcon(modelData.signalStrength)
                label: modelData.name
                detail: (modelData.type === "open" ? "" : "󰌾  ") + Math.round(modelData.signalStrength * 100) + "%"
                selected: modelData.connected
                interactive: !modelData.stateChanging
                onClicked: root.activateNetwork(modelData)
            }
        }
    }

    Column {
        width: parent.width
        spacing: 8
        visible: root.pendingNetwork !== null

        Separator { width: parent.width }

        SectionLabel { text: root.pendingNetwork ? root.pendingNetwork.name : "" }

        Rectangle {
            width: parent.width
            height: 38
            color: Theme.bg0
            border.width: 1
            border.color: passwordInput.activeFocus ? Theme.accent : Theme.border

            TextInput {
                id: passwordInput
                anchors.fill: parent
                anchors.leftMargin: 10
                anchors.rightMargin: 10
                color: Theme.fg1
                selectionColor: Theme.bg4
                selectedTextColor: Theme.fg1
                font.family: Theme.fontFamily
                font.pixelSize: Theme.body
                verticalAlignment: TextInput.AlignVCenter
                echoMode: TextInput.Password
                clip: true
                onAccepted: connectButton.clicked()

                StyledText {
                    visible: passwordInput.text.length === 0
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Password"
                    color: Theme.grey0
                }
            }
        }

        Row {
            width: parent.width
            layoutDirection: Qt.RightToLeft
            spacing: 6

            IconButton {
                id: connectButton
                label: "Connect"
                foreground: Theme.accent
                bordered: true
                enabled: passwordInput.text.length > 0
                onClicked: {
                    NetworkService.connectNetwork(root.pendingNetwork, passwordInput.text);
                    passwordInput.text = "";
                    root.pendingNetwork = null;
                }
            }

            IconButton {
                label: "Cancel"
                onClicked: {
                    passwordInput.text = "";
                    root.pendingNetwork = null;
                }
            }
        }
    }

    Connections {
        target: NetworkService
        function onConnectionError(message: string): void {
            root.connectionError = message;
        }
    }

    onShownChanged: {
        if (shown) {
            NetworkService.refreshScan();
        } else {
            passwordInput.text = "";
            pendingNetwork = null;
            connectionError = "";
        }
    }
}
