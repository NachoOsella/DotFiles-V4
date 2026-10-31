function mic --description 'Set the USB microphone as the default input'
    set -l source (pactl list short sources | string match -r 'alsa_input\.usb-[^\t]+' | head -n 1)
    if test -z "$source"
        echo "No USB microphone found" >&2
        return 1
    end
    pactl set-default-source $source
    echo "Microphone switched to $source"
end
