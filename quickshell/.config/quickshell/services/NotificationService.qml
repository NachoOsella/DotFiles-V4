pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Notifications

Singleton {
    id: root

    property var notifications: []
    property var toasts: []
    property bool doNotDisturb: false
    readonly property int count: notifications.length
    // Notifications grouped by application, newest group first.
    readonly property var groups: {
        const byApp = {};
        const order = [];
        for (const entry of notifications) {
            const name = entry.notification.appName || "System";
            if (!byApp[name]) {
                byApp[name] = [];
                order.push(name);
            }
            byApp[name].push(entry);
        }
        return order.map(name => ({ appName: name, entries: byApp[name] }));
    }

    function addNotification(notification: var): void {
        notification.tracked = true;
        const entry = { notification: notification, timestamp: new Date() };
        notifications = [entry].concat(notifications);
        // Critical notifications still show while Do Not Disturb is on.
        if (!doNotDisturb || notification.urgency === NotificationUrgency.Critical)
            toasts = [entry].concat(toasts).slice(0, 3);
        notification.closed.connect(() => removeNotification(notification));
    }

    function removeNotification(notification: var): void {
        notifications = notifications.filter(entry => entry.notification !== notification);
        toasts = toasts.filter(entry => entry.notification !== notification);
    }

    function hideToast(notification: var): void {
        toasts = toasts.filter(entry => entry.notification !== notification);
    }

    function dismiss(notification: var): void {
        if (notification)
            notification.dismiss();
        removeNotification(notification);
    }

    function dismissGroup(appName: string): void {
        for (const entry of notifications.slice()) {
            if ((entry.notification.appName || "System") === appName)
                dismiss(entry.notification);
        }
    }

    function clearAll(): void {
        const current = notifications.slice();
        notifications = [];
        toasts = [];
        for (const entry of current)
            entry.notification.dismiss();
    }

    function relativeTime(timestamp: date, now: date): string {
        const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
        if (seconds < 60)
            return "now";
        if (seconds < 3600)
            return Math.floor(seconds / 60) + "m";
        if (seconds < 86400)
            return Math.floor(seconds / 3600) + "h";
        return Qt.formatDate(timestamp, "d MMM");
    }

    function iconSource(notification: var): string {
        const iconName = notification.appIcon.toString();
        if (iconName.startsWith("/") || iconName.startsWith("file:") || iconName.startsWith("data:"))
            return iconName;
        if (iconName.length > 0) {
            const resolved = Quickshell.iconPath(iconName, true);
            if (resolved.length > 0)
                return resolved;
        }
        return notification.image.toString();
    }

    function attachedImage(notification: var): string {
        const image = notification.image.toString();
        return image.length > 0 && image !== iconSource(notification) ? image : "";
    }

    IpcHandler {
        target: "notifications"

        function toggleDoNotDisturb(): bool {
            root.doNotDisturb = !root.doNotDisturb;
            return root.doNotDisturb;
        }

        function clear(): void {
            root.clearAll();
        }
    }

    NotificationServer {
        keepOnReload: true
        persistenceSupported: true
        bodySupported: true
        bodyMarkupSupported: true
        bodyHyperlinksSupported: false
        bodyImagesSupported: true
        actionsSupported: true
        actionIconsSupported: true
        imageSupported: true
        inlineReplySupported: false

        onNotification: notification => root.addNotification(notification)
    }
}
