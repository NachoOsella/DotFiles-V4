pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Networking

Singleton {
    id: root

    readonly property var wifiDevice: Networking.devices.values.find(device => device.type === DeviceType.Wifi) ?? null
    readonly property var wiredDevice: Networking.devices.values.find(device => device.type === DeviceType.Wired) ?? null
    readonly property bool wifiAvailable: wifiDevice !== null && Networking.wifiHardwareEnabled
    readonly property bool wifiEnabled: wifiAvailable && Networking.wifiEnabled
    readonly property bool wiredConnected: wiredDevice !== null && wiredDevice.connected
    readonly property bool connected: wiredConnected || (wifiDevice !== null && wifiDevice.connected)
    readonly property var connectedNetwork: wifiDevice ? wifiDevice.networks.values.find(network => network.connected) ?? null : null
    readonly property string ssid: connectedNetwork ? connectedNetwork.name : ""
    readonly property real signalStrength: connectedNetwork ? connectedNetwork.signalStrength : 0
    readonly property string interfaceName: wiredConnected ? wiredDevice.name : wifiDevice ? wifiDevice.name : ""
    readonly property string address: wiredConnected ? wiredDevice.address : wifiDevice ? wifiDevice.address : ""
    readonly property var networks: wifiDevice ? wifiDevice.networks.values : []
    property real downloadBitsPerSecond: 0
    property real uploadBitsPerSecond: 0
    property real previousRxBytes: -1
    property real previousTxBytes: -1
    property double previousSampleTime: 0

    signal connectionError(string message)

    function wifiIcon(strength: real): string {
        if (!wifiEnabled || !connectedNetwork)
            return "󰤮";
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

    function toggleWifi(): void {
        if (wifiAvailable)
            Networking.wifiEnabled = !Networking.wifiEnabled;
    }

    function refreshScan(): void {
        if (!wifiDevice || !wifiEnabled)
            return;
        wifiDevice.scannerEnabled = true;
        scanStopTimer.restart();
    }

    function connectNetwork(network: var, password: string): void {
        if (!network)
            return;
        if (network.connected)
            network.disconnect();
        else if (network.known)
            network.connect();
        else if (network.security === WifiSecurityType.Open)
            network.connectWithPsk("");
        else if (password.length > 0)
            network.connectWithPsk(password);
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

    Timer {
        id: scanStopTimer
        interval: 10000
        onTriggered: {
            if (root.wifiDevice)
                root.wifiDevice.scannerEnabled = false;
        }
    }
}
