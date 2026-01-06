function gclone -d "Clona un repositorio de GitHub usando la cuenta 1 (personal) o 2 (facultad)"
    if test (count $argv) -ne 2
        echo "Uso: gclone 1|2 <ssh-url>"
        return 1
    end

    set -l account $argv[1]
    set -l url $argv[2]
    set -l host_alias ""

    # Validar que la URL tenga el formato correcto
    if not string match -qr '^git@github\.com:.*\.git$' $url
        echo "Error: La URL debe tener el formato 'git@github.com:Usuario/repo.git'"
        return 1
    end

    # Asignar alias según la cuenta
    switch $account
        case 1
            set host_alias github.com-personal
        case 2
            set host_alias github.com-facultad
        case '*'
            echo "Error: Cuenta inválida, elegí 1 (personal) o 2 (facultad)"
            return 1
    end

    # Reemplazar el host en la URL
    set -l new_url (string replace 'git@github.com' "git@$host_alias" $url)

    echo "🔄 Clonando con la cuenta $account:"
    echo "    → $new_url"
    git clone $new_url
    if test $status -ne 0
        echo "Error: No se pudo clonar el repositorio. Verifica la URL o las credenciales SSH."
        return 1
    end
end
