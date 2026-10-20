function power-mode --description 'Select automatic or performance power mode'
    if test (count $argv) -eq 0
        set argv status
    end
    qs -p "$HOME/.config/quickshell" ipc call power $argv
end
