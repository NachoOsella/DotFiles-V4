pragma Singleton

import Quickshell
import Quickshell.Bluetooth

Singleton {
    id: root

    readonly property var adapter: Bluetooth.defaultAdapter
    readonly property bool available: adapter !== null
    readonly property bool enabled: available && adapter.enabled
    readonly property var devices: Bluetooth.devices.values.filter(device => device.paired || device.bonded || device.connected)
    readonly property var connectedDevices: devices.filter(device => device.connected)
    readonly property string summary: connectedDevices.length > 0 ? connectedDevices.map(device => device.name || device.deviceName).join(", ") : enabled ? "On" : "Off"

    function toggle(): void {
        if (adapter)
            adapter.enabled = !adapter.enabled;
    }

    function toggleDevice(device: var): void {
        if (!device)
            return;
        if (device.connected)
            device.disconnect();
        else
            device.connect();
    }

    function startDiscovery(): void {
        if (adapter && adapter.enabled)
            adapter.discovering = true;
    }

    function stopDiscovery(): void {
        if (adapter && adapter.discovering)
            adapter.discovering = false;
    }
}
