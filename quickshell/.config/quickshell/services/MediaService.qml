pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Services.Mpris

Singleton {
    id: root

    // Players with useful metadata, Spotify first.
    readonly property list<var> players: Mpris.players.values
        .filter(candidate => candidate.trackTitle.length > 0 || candidate.trackArtist.length > 0)
        .sort((first, second) => Number(isSpotifyPlayer(second)) - Number(isSpotifyPlayer(first)))
    // Temporary pick from the media popup switcher; cleared when the popup closes.
    property var preferredPlayer: null
    readonly property var player: selectPlayer()
    readonly property bool available: player !== null && (player.trackTitle.length > 0 || player.trackArtist.length > 0)
    readonly property bool playing: available && player.isPlaying
    readonly property string title: available ? player.trackTitle : ""
    readonly property string artist: available ? player.trackArtist : ""
    readonly property string album: available ? player.trackAlbum : ""
    readonly property string identity: player ? (player.identity || player.desktopEntry || "") : ""
    readonly property bool spotifyPlayer: player !== null && isSpotifyPlayer(player)
    readonly property string artUrl: available ? player.trackArtUrl : ""
    readonly property string icon: spotifyPlayer ? "" : "󰎈"

    function isSpotifyPlayer(candidate: var): bool {
        if (!candidate)
            return false;
        const playerIdentity = [candidate.identity, candidate.desktopEntry, candidate.dbusName]
            .filter(value => value)
            .join(" ")
            .toLowerCase();
        return ["spotify", "spotifast", "spotatui"].some(name => playerIdentity.includes(name));
    }

    function selectPlayer(): var {
        const currentPlayers = Mpris.players.values;
        if (preferredPlayer && currentPlayers.includes(preferredPlayer))
            return preferredPlayer;
        // Spotify wins over other players in the same state: playing Spotify, other playing, paused Spotify, anything.
        return players.find(candidate => candidate.isPlaying && isSpotifyPlayer(candidate))
            ?? players.find(candidate => candidate.isPlaying)
            ?? players.find(candidate => isSpotifyPlayer(candidate))
            ?? players[0]
            ?? null;
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

    function toggleShuffle(): void {
        if (player && player.shuffleSupported)
            player.shuffle = !player.shuffle;
    }

    function cycleLoop(): void {
        if (!player || !player.loopSupported)
            return;
        player.loopState = player.loopState === MprisLoopState.None ? MprisLoopState.Playlist
            : player.loopState === MprisLoopState.Playlist ? MprisLoopState.Track : MprisLoopState.None;
    }

    function seek(position: real): void {
        if (player && player.canSeek && player.positionSupported)
            player.position = Math.max(0, Math.min(player.length, position));
    }
}
