import QtQuick
import "../components"
import "../config"
import "../services"

PopupSurface {
    id: root

    popupName: "media"
    surfaceWidth: 430
    property real displayedPosition: 0

    function syncPosition(): void {
        displayedPosition = MediaService.player && MediaService.player.positionSupported ? MediaService.player.position : 0;
    }

    function formatTime(seconds: real): string {
        if (!Number.isFinite(seconds) || seconds < 0)
            return "--:--";
        const total = Math.floor(seconds);
        const minutes = Math.floor(total / 60);
        return minutes + ":" + String(total % 60).padStart(2, "0");
    }

    Column {
        width: parent.width
        spacing: 10

        Item {
            width: parent.width
            height: 112

            Rectangle {
                id: artworkFrame
                anchors.left: parent.left
                width: 112
                height: 112
                radius: 2
                color: Theme.bg3
                clip: true

                Image {
                    id: artwork
                    anchors.fill: parent
                    source: MediaService.artUrl
                    asynchronous: true
                    cache: true
                    fillMode: Image.PreserveAspectCrop
                    sourceSize.width: 224
                    sourceSize.height: 224
                }

                StyledText {
                    anchors.centerIn: parent
                    visible: artwork.status !== Image.Ready
                    text: "󰎈"
                    color: Theme.grey1
                    font.family: Theme.iconFontFamily
                    font.pixelSize: 28
                }
            }

            Column {
                anchors.left: artworkFrame.right
                anchors.leftMargin: 12
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: 4

                StyledText {
                    width: parent.width
                    text: MediaService.identity || "Media player"
                    color: Theme.green
                    font.pixelSize: 12
                }

                StyledText {
                    width: parent.width
                    text: MediaService.title || "Nothing playing"
                    color: Theme.fg1
                    font.pixelSize: 17
                    font.weight: Font.Bold
                    wrapMode: Text.Wrap
                    maximumLineCount: 2
                }

                StyledText {
                    width: parent.width
                    text: MediaService.artist
                    color: Theme.fg0
                    font.pixelSize: Settings.smallFontSize
                }

                StyledText {
                    visible: MediaService.album.length > 0
                    width: parent.width
                    text: MediaService.album
                    color: Theme.grey2
                    font.pixelSize: 12
                }
            }
        }

        Item {
            visible: MediaService.player && MediaService.player.positionSupported && MediaService.player.lengthSupported
            width: parent.width
            height: visible ? 40 : 0

            StyledSlider {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                from: 0
                to: MediaService.player ? Math.max(1, MediaService.player.length) : 1
                value: root.displayedPosition
                accent: Theme.green
                onMoved: value => {
                    root.displayedPosition = value;
                    MediaService.seek(value);
                }
            }

            StyledText {
                anchors.left: parent.left
                anchors.bottom: parent.bottom
                text: root.formatTime(root.displayedPosition)
                color: Theme.grey2
                font.pixelSize: 12
            }

            StyledText {
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                text: root.formatTime(MediaService.player ? MediaService.player.length : 0)
                color: Theme.grey2
                font.pixelSize: 12
            }
        }

        Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 8

            IconButton {
                visible: MediaService.player && MediaService.player.canGoPrevious
                icon: "󰒮"
                buttonHeight: 38
                onClicked: MediaService.previous()
            }

            IconButton {
                visible: MediaService.player && MediaService.player.canTogglePlaying
                icon: MediaService.playing ? "󰏤" : "󰐊"
                foreground: Theme.green
                buttonHeight: 38
                onClicked: MediaService.toggle()
            }

            IconButton {
                visible: MediaService.player && MediaService.player.canGoNext
                icon: "󰒭"
                buttonHeight: 38
                onClicked: MediaService.next()
            }
        }
    }

    Connections {
        target: root
        function onVisibleChanged(): void {
            if (root.visible)
                root.syncPosition();
        }
    }

    Connections {
        target: MediaService.player
        function onPositionChanged(): void {
            if (root.visible)
                root.syncPosition();
        }
        function onTrackChanged(): void { root.syncPosition(); }
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.visible && MediaService.playing && MediaService.player && MediaService.player.positionSupported
        onTriggered: root.displayedPosition = Math.min(
            MediaService.player.lengthSupported ? MediaService.player.length : Number.MAX_VALUE,
            root.displayedPosition + Math.max(0.1, MediaService.player.rate)
        )
    }
}
