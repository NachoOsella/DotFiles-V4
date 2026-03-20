return {
    {
        "saghen/blink.cmp",
        opts = {
            -- Esto es clave para que se sienta como NvChad
            completion = {
                list = {
                    selection = {
                        preselect = false, -- No preseleccionar: Enter solo acepta si ya hay una opción resaltada
                        auto_insert = false, -- Evita que la selección escriba un preview en el buffer
                    },
                },
            },

            keymap = {
                -- Desactiva los presets para tener control manual total
                preset = "none",
                -- TAB: solo navegar completions -> siguiente snippet -> fallback
                ["<Tab>"] = { "select_next", "snippet_forward", "fallback" },

                -- SHIFT-TAB: solo navegar completions -> snippet anterior -> fallback
                ["<S-Tab>"] = { "select_prev", "snippet_backward", "fallback" },
                -- ENTER: aceptar la opción resaltada -> fallback (nueva línea normal)
                ["<CR>"] = { "accept", "fallback" },
                -- Controles básicos de scroll documentación (opcional)
                ["<C-space>"] = { "show", "show_documentation", "hide_documentation" },
                ["<C-e>"] = { "hide" },
            },
        },
    },
}
