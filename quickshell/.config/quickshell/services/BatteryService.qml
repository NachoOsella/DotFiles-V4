pragma Singleton

import Quickshell
import Quickshell.Services.UPower

Singleton {
    id: root

    readonly property var battery: UPower.displayDevice
    readonly property bool available: battery !== null && battery.ready && battery.isPresent
    readonly property int percentage: available ? Math.round(battery.percentage * 100) : 0
    readonly property bool charging: available && (battery.state === UPowerDeviceState.Charging || battery.state === UPowerDeviceState.PendingCharge)
    readonly property bool plugged: available && !UPower.onBattery
    readonly property bool full: available && battery.state === UPowerDeviceState.FullyCharged
    readonly property real timeRemaining: available ? charging ? battery.timeToFull : battery.timeToEmpty : 0
    readonly property int health: available && battery.healthSupported ? Math.round(battery.healthPercentage * 100) : -1
    readonly property real rate: available ? battery.changeRate : 0

    function iconFor(level: int): string {
        if (charging)
            return "";
        if (plugged && full)
            return "";
        if (level <= 10)
            return "";
        if (level <= 30)
            return "";
        if (level <= 50)
            return "";
        if (level <= 75)
            return "";
        return "";
    }

    function formatDuration(seconds: real): string {
        if (!Number.isFinite(seconds) || seconds <= 0)
            return "Unknown";
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return hours > 0 ? hours + "h " + minutes + "m" : minutes + "m";
    }
}
