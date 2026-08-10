import QtQuick
import Quickshell.Networking
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "network"
    surfaceWidth: 440
    needsKeyboardFocus: pendingNetwork !== null
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
        if (network.connected || network.known || network.security === WifiSecurityType.Open) {
            pendingNetwork = null;
            NetworkService.connectNetwork(network, "");
        } else {
            pendingNetwork = network;
            passwordInput.text = "";
            passwordInput.forceActiveFocus();
        }
    }

    Column {
        width: parent.width
        spacing: 7

        Row {
            width: parent.width

            StyledText {
                width: parent.width - wifiToggle.width - scanButton.width
                text: "Network"
                color: Theme.fg1
                font.pixelSize: Settings.fontSize
                font.weight: Font.Bold
            }

            IconButton {
                id: scanButton
                icon: "󰑓"
                enabled: NetworkService.wifiEnabled
                onClicked: NetworkService.refreshScan()
            }

            IconButton {
                id: wifiToggle
                icon: NetworkService.wifiEnabled ? "󰖪" : "󰖩"
                foreground: NetworkService.wifiEnabled ? Theme.green : Theme.grey1
                enabled: NetworkService.wifiAvailable
                onClicked: NetworkService.toggleWifi()
            }
        }

        PopupRow {
            width: parent.width
            icon: NetworkService.wiredConnected ? "󰈀" : NetworkService.wifiIcon(NetworkService.signalStrength)
            iconColor: NetworkService.connected ? Theme.aqua : Theme.grey1
            label: NetworkService.connected ? NetworkService.ssid || "Wired" : "Disconnected"
            detail: NetworkService.connected ? NetworkService.address : ""
        }

        Separator { width: parent.width }

        StyledText {
            text: "Wi-Fi networks"
            color: Theme.grey2
            font.pixelSize: 12
        }

        StyledText {
            visible: !NetworkService.wifiAvailable
            text: "Wi-Fi unavailable"
            color: Theme.grey1
            font.pixelSize: Settings.smallFontSize
        }

        StyledText {
            visible: NetworkService.wifiAvailable && !NetworkService.wifiEnabled
            text: "Wi-Fi is disabled"
            color: Theme.grey1
            font.pixelSize: Settings.smallFontSize
        }

        StyledText {
            visible: root.connectionError.length > 0
            width: parent.width
            text: root.connectionError
            color: Theme.orange
            font.pixelSize: Settings.smallFontSize
            wrapMode: Text.Wrap
        }

        Repeater {
            model: root.sortedNetworks

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: NetworkService.wifiIcon(modelData.signalStrength)
                iconColor: modelData.connected ? Theme.green : Theme.grey2
                label: modelData.name
                detail: (modelData.security === WifiSecurityType.Open ? "" : "  ") + Math.round(modelData.signalStrength * 100) + "%"
                selected: modelData.connected
                interactive: !modelData.stateChanging
                onClicked: root.activateNetwork(modelData)

                Connections {
                    target: modelData
                    function onConnectionFailed(): void {
                        root.connectionError = "Connection failed. Check the password or network state and try again.";
                    }
                }
            }
        }

        Column {
            width: parent.width
            spacing: 6
            visible: root.pendingNetwork !== null

            Separator { width: parent.width }

            StyledText {
                text: root.pendingNetwork ? "Password for " + root.pendingNetwork.name : "Password"
                color: Theme.fg0
                font.pixelSize: Settings.smallFontSize
            }

            Rectangle {
                width: parent.width
                height: 38
                color: Theme.bg0
                border.width: 1
                border.color: passwordInput.activeFocus ? Theme.aqua : Theme.border
                radius: 4

                TextInput {
                    id: passwordInput
                    anchors.fill: parent
                    anchors.leftMargin: 8
                    anchors.rightMargin: 8
                    color: Theme.fg1
                    selectionColor: Theme.bg5
                    selectedTextColor: Theme.fg1
                    font.family: Theme.fontFamily
                    font.pixelSize: Settings.smallFontSize
                    verticalAlignment: TextInput.AlignVCenter
                    echoMode: TextInput.Password
                    clip: true
                    onAccepted: connectButton.clicked()
                }
            }

            Row {
                width: parent.width
                layoutDirection: Qt.RightToLeft
                spacing: 6

                IconButton {
                    id: connectButton
                    icon: "󰌷"
                    label: "Connect"
                    foreground: Theme.green
                    enabled: passwordInput.text.length > 0
                    onClicked: {
                        NetworkService.connectNetwork(root.pendingNetwork, passwordInput.text);
                        passwordInput.text = "";
                        root.pendingNetwork = null;
                    }
                }

                IconButton {
                    icon: "󰅖"
                    label: "Cancel"
                    onClicked: {
                        passwordInput.text = "";
                        root.pendingNetwork = null;
                    }
                }
            }
        }
    }

    Connections {
        target: root
        function onVisibleChanged(): void {
            if (root.visible)
                NetworkService.refreshScan();
            else {
                if (NetworkService.wifiDevice)
                    NetworkService.wifiDevice.scannerEnabled = false;
                passwordInput.text = "";
                root.pendingNetwork = null;
                root.connectionError = "";
            }
        }
    }
}
