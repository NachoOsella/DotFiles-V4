function ghswitch -d "Switch the active GitHub CLI account"
    if test (count $argv) -ne 1
        echo "Usage: ghswitch personal|facu"
        return 1
    end

    set -l account $argv[1]
    set -l username

    switch $account
        case personal 1
            set username NachoOsella
        case facu 2 university
            set username 412023-OSELLA
        case '*'
            echo "Error: choose personal or facu"
            return 1
    end

    gh auth switch --hostname github.com --user $username
    or return 1

    echo "GitHub CLI account: $username"
end
