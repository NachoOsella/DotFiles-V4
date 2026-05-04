return {
    {
        "saghen/blink.cmp",
        opts = {
            -- Key setting for an NvChad-like completion feel
            completion = {
                list = {
                    selection = {
                        preselect = false, -- Do not preselect: Enter only accepts an explicitly highlighted item
                        auto_insert = false, -- Prevent selection preview text from being inserted into the buffer
                    },
                },
            },

            keymap = {
                -- Disable presets for full manual control
                preset = "none",
                -- TAB: completion navigation -> next snippet -> fallback
                ["<Tab>"] = { "select_next", "snippet_forward", "fallback" },

                -- SHIFT-TAB: completion navigation -> previous snippet -> fallback
                ["<S-Tab>"] = { "select_prev", "snippet_backward", "fallback" },
                -- ENTER: accept highlighted option -> fallback (normal newline)
                ["<CR>"] = { "accept", "fallback" },
                -- Basic documentation scroll controls (optional)
                ["<C-space>"] = { "show", "show_documentation", "hide_documentation" },
                ["<C-e>"] = { "hide" },
            },
        },
    },
}
