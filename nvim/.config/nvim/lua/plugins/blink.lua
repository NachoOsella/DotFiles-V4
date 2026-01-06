return {
    {
        "saghen/blink.cmp",
        opts = {
            -- Esto es clave para que se sienta como NvChad
            completion = {
                list = {
                    selection = {
                        preselect = false, -- No preseleccionar, obligar a usar Tab para bajar
                        auto_insert = true,
                    },
                },
            },

            keymap = {
                -- Desactiva los presets para tener control manual total
                preset = "none",
                -- TAB: Bajar en la lista -> Siguiente snippet -> Fallback (tab normal)
                ["<Tab>"] = { "select_next", "snippet_forward", "fallback" },

                -- SHIFT-TAB: Subir en la lista -> Snippet anterior -> Fallback
                ["<S-Tab>"] = { "select_prev", "snippet_backward", "fallback" },
                -- ENTER: Aceptar -> Fallback (nueva línea normal)
                ["<CR>"] = { "accept", "fallback" },
                -- Controles básicos de scroll documentación (opcional)
                ["<C-space>"] = { "show", "show_documentation", "hide_documentation" },
                ["<C-e>"] = { "hide" },
            },
        },
    },
}
