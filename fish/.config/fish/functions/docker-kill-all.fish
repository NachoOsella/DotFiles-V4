function docker-kill-all
    set containers (docker ps --quiet)
    if test (count $containers) -eq 0
        echo "No running Docker containers."
        return
    end

    docker kill $containers
end
