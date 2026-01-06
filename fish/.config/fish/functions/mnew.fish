function mnew
    read -p "GroupId (ej: com.nacho): " GROUPID
    read -p "ArtifactId (ej: miapp): " ARTIFACTID
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
