pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io

Singleton {
    id: root

    property var status: ({})
    readonly property bool wifiAvailable: status.wifiAvailable ?? false
    readonly property bool wifiEnabled: status.wifiEnabled ?? false
    readonly property bool wifiConnected: status.wifiConnected ?? false
    readonly property bool wiredConnected: status.wiredConnected ?? false
    readonly property bool connected: wiredConnected || wifiConnected
    readonly property string ssid: status.ssid ?? ""
    readonly property real signalStrength: status.signalStrength ?? 0
    readonly property string connectionLabel: {
        if (!connected)
            return wifiEnabled ? "Disconnected" : "Off";
        if (ssid.length > 0)
            return ssid;
        return wiredConnected ? "Wired" : "Connected";
    }
    readonly property string interfaceName: status.interfaceName ?? ""
    readonly property string address: status.address ?? ""
    readonly property var networks: status.networks ?? []
    property real downloadBitsPerSecond: 0
    property real uploadBitsPerSecond: 0
    property real previousRxBytes: -1
    property real previousTxBytes: -1
    property double previousSampleTime: 0

    signal connectionError(string message)

    function wifiIcon(strength: real): string {
        if (!wifiEnabled || !wifiConnected)
            return "󰤮";
        if (strength <= 0)
            return "󰤢";
        if (strength < 0.2)
            return "󰤯";
        if (strength < 0.4)
            return "󰤟";
        if (strength < 0.6)
            return "󰤢";
        if (strength < 0.8)
            return "󰤥";
        return "󰤨";
    }

    function formatRate(bits: real): string {
        if (bits < 1000)
            return Math.round(bits) + " b/s";
        if (bits < 1000000)
            return (bits / 1000).toFixed(bits < 10000 ? 1 : 0) + " Kb/s";
        if (bits < 1000000000)
            return (bits / 1000000).toFixed(bits < 10000000 ? 1 : 0) + " Mb/s";
        return (bits / 1000000000).toFixed(1) + " Gb/s";
    }

    function request(action: var): void {
        if (!iwd.running) {
            connectionError("The iwd client is unavailable");
            return;
        }
        iwd.write(JSON.stringify(action) + "\n");
    }

    function toggleWifi(): void {
        if (wifiAvailable)
            request({action: "toggle"});
    }

    function refreshScan(): void {
        if (wifiEnabled)
            request({action: "scan"});
    }

    function connectNetwork(network: var, password: string): void {
        if (!network)
            return;
        if (!network.known && network.type !== "open" && network.type !== "psk") {
            connectionError("Configure this enterprise network with iwctl first");
            return;
        }
        request({action: network.connected ? "disconnect" : "connect", path: network.path, password: password});
    }

    onInterfaceNameChanged: {
        previousRxBytes = -1;
        previousTxBytes = -1;
        previousSampleTime = 0;
        downloadBitsPerSecond = 0;
        uploadBitsPerSecond = 0;
    }

    function consumeSample(): void {
        const rx = Number(rxFile.text().trim());
        const tx = Number(txFile.text().trim());
        const now = Date.now();
        if (!Number.isFinite(rx) || !Number.isFinite(tx))
            return;
        if (previousRxBytes >= 0 && previousTxBytes >= 0 && previousSampleTime > 0) {
            const seconds = Math.max(0.1, (now - previousSampleTime) / 1000);
            downloadBitsPerSecond = Math.max(0, (rx - previousRxBytes) * 8 / seconds);
            uploadBitsPerSecond = Math.max(0, (tx - previousTxBytes) * 8 / seconds);
        }
        previousRxBytes = rx;
        previousTxBytes = tx;
        previousSampleTime = now;
    }

    FileView {
        id: rxFile
        path: root.interfaceName.length > 0 ? "/sys/class/net/" + root.interfaceName + "/statistics/rx_bytes" : ""
        preload: root.interfaceName.length > 0
        printErrors: false
        onLoaded: sampleTimer.restart()
    }

    FileView {
        id: txFile
        path: root.interfaceName.length > 0 ? "/sys/class/net/" + root.interfaceName + "/statistics/tx_bytes" : ""
        preload: root.interfaceName.length > 0
        printErrors: false
        onLoaded: sampleTimer.restart()
    }

    Timer {
        id: sampleTimer
        interval: 25
        onTriggered: root.consumeSample()
    }

    Timer {
        interval: 5000
        repeat: true
        running: root.connected && root.interfaceName.length > 0
        onTriggered: {
            rxFile.reload();
            txFile.reload();
        }
    }

    Process {
        id: iwd
        command: ["python3", Qt.resolvedUrl("../scripts/iwd-client.py").toString().replace(/^file:\/\//, ""), "watch"]
        stdinEnabled: true
        running: true
        stdout: SplitParser {
            onRead: data => {
                try {
                    const message = JSON.parse(data);
                    if (message.status)
                        root.status = message.status;
                    if (message.error)
                        root.connectionError(message.error);
                } catch (error) {
                    root.connectionError("Invalid response from the iwd client");
                }
            }
        }
        onExited: {
            root.status = ({});
            root.connectionError("The iwd client stopped. Restart Quickshell to reconnect.");
        }
    }
}
