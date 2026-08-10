pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Services.Notifications
import "../config"

Singleton {
    id: root

    property var notifications: []
    property var toasts: []
    readonly property int count: notifications.length

    function addNotification(notification: var): void {
        notification.tracked = true;
        const entry = { notification: notification, timestamp: new Date() };
        notifications = [entry].concat(notifications);
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

    function clearAll(): void {
        const current = notifications.slice();
        notifications = [];
        toasts = [];
        for (const entry of current)
            entry.notification.dismiss();
    }

    LazyLoader {
        active: Settings.notificationServerEnabled

        component: Component {
            NotificationServer {
                keepOnReload: true
                persistenceSupported: true
                bodySupported: true
                bodyMarkupSupported: false
                bodyHyperlinksSupported: false
                bodyImagesSupported: true
                actionsSupported: true
                actionIconsSupported: true
                imageSupported: true
                inlineReplySupported: false

                onNotification: notification => root.addNotification(notification)
            }
        }
    }
}
