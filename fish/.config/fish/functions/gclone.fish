function gclone -d "Clone a GitHub repository using account 1 (personal) or 2 (university)"
    if test (count $argv) -ne 2
        echo "Usage: gclone 1|2 <ssh-url>"
        return 1
    end

    set -l account $argv[1]
    set -l url $argv[2]
    set -l host_alias ""

    # Validate that the URL has the correct format
    if not string match -qr '^git@github\.com:.*\.git$' $url
        echo "Error: URL must follow format 'git@github.com:username/repo.git'"
        return 1
    end

    # Assign alias based on selected account
    switch $account
        case 1
            set host_alias github.com-personal
        case 2
            set host_alias github.com-facultad
        case '*'
            echo "Error: Invalid account, choose 1 (personal) or 2 (university)"
            return 1
    end

    # Replace host in URL
    set -l new_url (string replace 'git@github.com' "git@$host_alias" $url)

    echo "Cloning with account $account:"
    echo "    → $new_url"
    git clone $new_url
    if test $status -ne 0
        echo "Error: Could not clone repository. Check URL or SSH credentials."
        return 1
    end
end
