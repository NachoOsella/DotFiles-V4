function mnew
    read -p "GroupId (e.g. com.example): " GROUPID
    read -p "ArtifactId (e.g. my-app): " ARTIFACTID
    read -p "Archetype (default maven-archetype-quickstart): " ARCHETYPE
    if test -z "$ARCHETYPE"
        set ARCHETYPE maven-archetype-quickstart
    end
    read -p "Version (default 1.0-SNAPSHOT): " VERSION
    if test -z "$VERSION"
        set VERSION 1.0-SNAPSHOT
    end

    mvn archetype:generate \
        -DgroupId=$GROUPID \
        -DartifactId=$ARTIFACTID \
        -DarchetypeArtifactId=$ARCHETYPE \
        -Dversion=$VERSION \
        -DinteractiveMode=false
end
