pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Services.Mpris

Singleton {
    id: root

    readonly property list<var> players: Mpris.players.values
    readonly property var player: selectPlayer()
    readonly property bool available: player !== null && (player.trackTitle.length > 0 || player.trackArtist.length > 0)
    readonly property bool playing: available && player.isPlaying
    readonly property string title: available ? player.trackTitle : ""
    readonly property string artist: available ? player.trackArtist : ""
    readonly property string album: available ? player.trackAlbum : ""
    readonly property string identity: player ? (player.identity || player.desktopEntry || "") : ""
    readonly property bool spotifyPlayer: player !== null && isSpotifyPlayer(player)
    readonly property string artUrl: available ? player.trackArtUrl : ""
    readonly property string trackText: {
        if (!available)
            return "";
        if (artist.length > 0 && title.length > 0)
            return artist + "  —  " + title;
        return title || artist;
    }
    readonly property string icon: spotifyPlayer ? "" : "󰎈"

    function isSpotifyPlayer(candidate: var): bool {
        if (!candidate)
            return false;
        const playerIdentity = [candidate.identity, candidate.desktopEntry, candidate.dbusName]
            .filter(value => value)
            .join(" ")
            .toLowerCase();
        return playerIdentity.includes("spotify") || playerIdentity.includes("spotatui");
    }

    function selectPlayer(): var {
        const currentPlayers = Mpris.players.values;
        for (const candidate of currentPlayers) {
            if (candidate.isPlaying && (candidate.trackTitle.length > 0 || candidate.trackArtist.length > 0))
                return candidate;
        }
        for (const candidate of currentPlayers) {
            if (isSpotifyPlayer(candidate))
                return candidate;
        }
        for (const candidate of currentPlayers) {
            if (candidate.trackTitle.length > 0 || candidate.trackArtist.length > 0)
                return candidate;
        }
        return null;
    }

    function toggle(): void {
        if (player && player.canTogglePlaying)
            player.togglePlaying();
    }

    function next(): void {
        if (player && player.canGoNext)
            player.next();
    }

    function previous(): void {
        if (player && player.canGoPrevious)
            player.previous();
    }

    function seek(position: real): void {
        if (player && player.canSeek && player.positionSupported)
            player.position = Math.max(0, Math.min(player.length, position));
    }
}
