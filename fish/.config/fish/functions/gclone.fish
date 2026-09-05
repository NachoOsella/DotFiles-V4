function gclone -d "Clone a GitHub repository using account 1 (personal) or 2 (university)"
    if test (count $argv) -ne 2
        echo "Usage: gclone 1|2 <ssh-url>"
        return 1
    end

    set -l account $argv[1]
    set -l url $argv[2]
    set -l host_alias ""
    set -l author_name ""
    set -l author_email ""

    # Validate that the URL has the correct format
    if not string match -qr '^git@github\.com:.*\.git$' $url
        echo "Error: URL must follow format 'git@github.com:username/repo.git'"
        return 1
    end

    # Assign alias based on selected account
    switch $account
        case 1
            set host_alias github.com-personal
            set author_name NachoOsella
            set author_email nachoosella03@gmail.com
        case 2
            set host_alias github.com-facultad
            set author_name 412023-OSELLA
            set author_email 412023@tecnicatura.frc.utn.edu.ar
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

    # Set the commit author locally for the newly cloned repository.
    set -l repository_name (string split '/' -- $url)[-1]
    set repository_name (string replace -r '\.git$' '' $repository_name)
    set -l repository_path (pwd)/$repository_name

    if not git -C "$repository_path" config --local user.name "$author_name"
        echo "Error: Could not configure the local Git author."
        return 1
    end

    if not git -C "$repository_path" config --local user.email "$author_email"
        echo "Error: Could not configure the local Git email."
        return 1
    end

    echo "Git author configured as: $author_name <$author_email>"
end
