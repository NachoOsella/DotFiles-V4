import QtQuick
import Quickshell.Services.Mpris
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "media"
    surfaceWidth: 460
    property real displayedPosition: 0
    readonly property var player: MediaService.player

    function syncPosition(): void {
        displayedPosition = player && player.positionSupported ? player.position : 0;
    }

    function formatTime(seconds: real): string {
        if (!Number.isFinite(seconds) || seconds < 0)
            return "-:--";
        const total = Math.floor(seconds);
        return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    }

    Item {
        width: parent.width
        height: 136

        Rectangle {
            id: artworkFrame
            width: 136
            height: 136
            color: Theme.raised
            border.width: 1
            border.color: Theme.border
            clip: true

            Image {
                id: artwork
                anchors.fill: parent
                anchors.margins: 1
                source: MediaService.artUrl
                asynchronous: true
                cache: true
                fillMode: Image.PreserveAspectCrop
                sourceSize.width: 240
                sourceSize.height: 240
            }

            Icon {
                anchors.centerIn: parent
                visible: artwork.status !== Image.Ready
                text: MediaService.icon
                color: Theme.grey0
                font.pixelSize: Theme.display
            }

            MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.NoButton
                property real wheelDelta: 0
                onWheel: wheel => {
                    wheelDelta += wheel.angleDelta.y;
                    if (Math.abs(wheelDelta) < 120)
                        return;
                    if (wheelDelta > 0)
                        MediaService.previous();
                    else
                        MediaService.next();
                    wheelDelta = 0;
                }
            }
        }

        Column {
            anchors.left: artworkFrame.right
            anchors.leftMargin: 16
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: 4

            SectionLabel {
                width: parent.width
                text: (MediaService.identity || "Media") + (MediaService.playing ? "" : "  ·  paused")
                color: MediaService.playing ? Theme.accent : Theme.grey0
            }

            StyledText {
                width: parent.width
                text: MediaService.title || "Nothing playing"
                color: Theme.fg1
                font.pixelSize: Theme.title
                font.weight: Font.Bold
                wrapMode: Text.Wrap
                maximumLineCount: 2
            }

            StyledText {
                width: parent.width
                text: MediaService.artist
                color: Theme.fg0
            }

            StyledText {
                visible: MediaService.album.length > 0
                width: parent.width
                text: MediaService.album
                color: Theme.grey1
                font.pixelSize: Theme.label
            }
        }
    }

    Column {
        visible: root.player !== null && root.player.positionSupported && root.player.lengthSupported
        width: parent.width
        spacing: 2

        StyledSlider {
            width: parent.width
            from: 0
            to: root.player ? Math.max(1, root.player.length) : 1
            value: root.displayedPosition
            trackHeight: 3
            enabled: root.player !== null && root.player.canSeek
            onMoved: value => {
                root.displayedPosition = value;
                MediaService.seek(value);
            }
        }

        Item {
            width: parent.width
            height: 16

            StyledText {
                anchors.left: parent.left
                text: root.formatTime(root.displayedPosition)
                color: Theme.grey1
                font.pixelSize: Theme.caption
            }

            StyledText {
                anchors.right: parent.right
                text: root.formatTime(root.player ? root.player.length : 0)
                color: Theme.grey1
                font.pixelSize: Theme.caption
            }
        }
    }

    Item {
        width: parent.width
        height: 40

        IconButton {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            visible: root.player !== null && root.player.shuffleSupported
            icon: "󰒟"
            selected: root.player !== null && root.player.shuffle
            onClicked: MediaService.toggleShuffle()
        }

        Row {
            anchors.centerIn: parent
            spacing: 6

            IconButton {
                anchors.verticalCenter: parent.verticalCenter
                icon: "󰒮"
                buttonHeight: 36
                enabled: root.player !== null && root.player.canGoPrevious
                onClicked: MediaService.previous()
            }

            IconButton {
                anchors.verticalCenter: parent.verticalCenter
                icon: MediaService.playing ? "󰏤" : "󰐊"
                foreground: Theme.accent
                bordered: true
                buttonHeight: 40
                iconSize: Theme.iconLarge
                enabled: root.player !== null && root.player.canTogglePlaying
                onClicked: MediaService.toggle()
            }

            IconButton {
                anchors.verticalCenter: parent.verticalCenter
                icon: "󰒭"
                buttonHeight: 36
                enabled: root.player !== null && root.player.canGoNext
                onClicked: MediaService.next()
            }
        }

        IconButton {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: root.player !== null && root.player.loopSupported
            icon: root.player && root.player.loopState === MprisLoopState.Track ? "󰑘" : "󰑖"
            selected: root.player !== null && root.player.loopState !== MprisLoopState.None
            onClicked: MediaService.cycleLoop()
        }
    }

    // Player switcher, shown only when several players are active.
    Column {
        visible: MediaService.players.length > 1
        width: parent.width
        spacing: 4

        Separator { width: parent.width }

        Repeater {
            model: MediaService.players

            delegate: PopupRow {
                required property var modelData
                width: parent.width
                icon: MediaService.isSpotifyPlayer(modelData) ? "\uf1bc" : "󰎈"
                label: modelData.identity || modelData.desktopEntry || "Player"
                detail: modelData.trackTitle
                selected: modelData === MediaService.player
                interactive: modelData !== MediaService.player
                onClicked: MediaService.preferredPlayer = modelData
            }
        }
    }

    onShownChanged: {
        if (shown)
            syncPosition();
        else
            MediaService.preferredPlayer = null;
    }

    Connections {
        target: root.player
        function onPositionChanged(): void {
            if (root.shown)
                root.syncPosition();
        }
        function onTrackChanged(): void { root.syncPosition(); }
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.shown && MediaService.playing && root.player !== null && root.player.positionSupported
        onTriggered: root.displayedPosition = Math.min(
            root.player.lengthSupported ? root.player.length : Number.MAX_VALUE,
            root.displayedPosition + Math.max(0.1, root.player.rate)
        )
    }
}
