pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io
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
    property bool automaticProfiles: true
    readonly property int automaticPowerProfile: UPower.onBattery ? PowerProfile.PowerSaver : PowerProfile.Balanced
    readonly property bool hasPerformanceProfile: PowerProfiles.hasPerformanceProfile
    readonly property string powerProfileName: PowerProfiles.profile === PowerProfile.PowerSaver ? "Power saver"
        : PowerProfiles.profile === PowerProfile.Performance ? "Performance" : "Balanced"

    onAutomaticPowerProfileChanged: applyPowerProfile()
    Component.onCompleted: applyPowerProfile()

    function applyPowerProfile(): void {
        if (automaticProfiles)
            PowerProfiles.profile = automaticPowerProfile;
    }

    function setAutomaticMode(): string {
        automaticProfiles = true;
        applyPowerProfile();
        return "Automatic power mode";
    }

    function setPerformanceMode(): string {
        if (!hasPerformanceProfile)
            return "Performance profile unavailable";
        automaticProfiles = false;
        PowerProfiles.profile = PowerProfile.Performance;
        return "Manual performance mode";
    }

    IpcHandler {
        target: "power"

        function auto(): string {
            return root.setAutomaticMode();
        }

        function performance(): string {
            return root.setPerformanceMode();
        }

        function status(): string {
            return (root.automaticProfiles ? "auto: " : "manual: ") + PowerProfile.toString(PowerProfiles.profile);
        }
    }

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
