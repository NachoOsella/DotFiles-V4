function mic
    pactl set-source-port alsa_input.pci-0000_00_1f.3.analog-stereo analog-input-headset-mic
    echo "Micrófono cambiado a headset"
end
