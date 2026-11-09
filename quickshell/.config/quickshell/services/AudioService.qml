pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Services.Pipewire

Singleton {
    id: root

    readonly property var sink: Pipewire.defaultAudioSink
    readonly property var source: Pipewire.defaultAudioSource
    readonly property bool sinkReady: sink !== null && sink.ready && sink.audio !== null
    readonly property bool sourceReady: source !== null && source.ready && source.audio !== null
    readonly property real volume: sinkReady ? sink.audio.volume : 0
    readonly property bool muted: sinkReady ? sink.audio.muted : false
    readonly property real microphoneVolume: sourceReady ? source.audio.volume : 0
    readonly property bool microphoneMuted: sourceReady ? source.audio.muted : false
    readonly property string sinkName: sinkReady ? sink.description || sink.nickname || sink.name : "No output"
    readonly property string sourceName: sourceReady ? source.description || source.nickname || source.name : "No microphone"
    // Hardware outputs only; virtual processing sinks are not useful choices.
    readonly property list<var> outputNodes: Pipewire.nodes.values.filter(node => node && node.isSink && !node.isStream && node.properties["node.virtual"] !== "true")
    readonly property list<var> streamNodes: Pipewire.nodes.values.filter(node => node && node.isStream && node.isSink)

    property bool sinkObserved: false
    property bool sourceObserved: false

    signal osdRequested(string icon, int percentage, bool muted)
    signal microphoneOsdRequested(bool muted)

    PwObjectTracker {
        objects: [root.sink, root.source].concat(root.outputNodes).concat(root.streamNodes)
    }

    function volumeIcon(value: real, isMuted: bool): string {
        if (isMuted)
            return "󰖁";
        if (value <= 0.01)
            return "";
        if (value < 0.34)
            return "";
        if (value < 0.67)
            return "󰕾";
        return "";
    }

    function setVolume(value: real): void {
        if (!sinkReady)
            return;
        const previousVolume = volume;
        const targetVolume = Math.max(0, Math.min(1.5, value));
        if (targetVolume > previousVolume && sink.audio.muted)
            sink.audio.muted = false;
        sink.audio.volume = targetVolume;
        osdRequested(volumeIcon(sink.audio.volume, sink.audio.muted), Math.round(sink.audio.volume * 100), sink.audio.muted);
    }

    function adjustVolume(delta: real): void {
        setVolume(volume + delta);
    }

    function toggleMute(): void {
        if (!sinkReady)
            return;
        sink.audio.muted = !sink.audio.muted;
        osdRequested(volumeIcon(volume, sink.audio.muted), Math.round(volume * 100), sink.audio.muted);
    }

    function toggleMicrophoneMute(): void {
        if (!sourceReady)
            return;
        source.audio.muted = !source.audio.muted;
        microphoneOsdRequested(source.audio.muted);
    }

    function showVolumeOsd(): void {
        osdRequested(volumeIcon(volume, muted), Math.round(volume * 100), muted);
    }

    // Shorten ALSA descriptions such as "Core Ultra 200V Series Processors HD Audio Speaker".
    function nodeLabel(node: var): string {
        if (!node)
            return "";
        const description = node.description || node.nickname || node.name || "";
        const hdmi = description.match(/HDMI \/ DisplayPort (\d+)/);
        if (hdmi)
            return "HDMI " + hdmi[1];
        return description.replace(/^.*HD Audio /, "").replace(/ Analog Stereo$/, "");
    }

    function streamLabel(node: var): string {
        const properties = node.properties;
        const name = properties["application.name"] || properties["node.name"] || node.name || "";
        return name.split(".")[0].replace(/^\w/, letter => letter.toUpperCase());
    }

    function setDefaultOutput(node: var): void {
        if (node)
            Pipewire.preferredDefaultAudioSink = node;
    }

    function setNodeVolume(node: var, value: real): void {
        if (node && node.ready && node.audio)
            node.audio.volume = Math.max(0, Math.min(1.5, value));
    }

    Connections {
        target: root.sinkReady ? root.sink.audio : null

        function onVolumeChanged(): void {
            if (root.sinkObserved)
                root.showVolumeOsd();
            root.sinkObserved = true;
        }

        function onMutedChanged(): void {
            if (root.sinkObserved)
                root.showVolumeOsd();
            root.sinkObserved = true;
        }
    }

    Connections {
        target: root.sourceReady ? root.source.audio : null

        function onMutedChanged(): void {
            if (root.sourceObserved)
                root.microphoneOsdRequested(root.microphoneMuted);
            root.sourceObserved = true;
        }
    }

    Connections {
        target: Pipewire
        function onDefaultAudioSinkChanged(): void { root.sinkObserved = false; }
        function onDefaultAudioSourceChanged(): void { root.sourceObserved = false; }
    }
}
