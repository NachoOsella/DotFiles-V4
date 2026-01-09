return {
    {
        "folke/snacks.nvim",
        opts = function(_, opts)
            opts = opts or {}

            -- Dashboard (tu config)
            opts.dashboard = opts.dashboard or {}
            opts.dashboard.preset = opts.dashboard.preset or {}
            local arch = ""
            opts.dashboard.preset.header = table.concat({
                "███╗   ██╗███████╗ ██████╗ ██╗   ██╗██╗███╗   ███╗",
                "████╗  ██║██╔════╝██╔═══██╗██║   ██║██║████╗ ████║",
                "██╔██╗ ██║█████╗  ██║   ██║██║   ██║██║██╔████╔██║",
                "██║╚██╗██║██╔══╝  ██║   ██║╚██╗ ██╔╝██║██║╚██╔╝██║",
                "██║ ╚████║███████╗╚██████╔╝ ╚████╔╝ ██║██║ ╚═╝ ██║",
                "╚═╝  ╚═══╝╚══════╝ ╚═════╝   ╚═══╝  ╚═╝╚═╝     ╚═╝",
                "",
                ("                    %s  i use arch btw  %s"):format(arch, arch),
            }, "\n")

            -- Snacks Picker / Explorer
            opts.picker = opts.picker or {}
            opts.picker.sources = opts.picker.sources or {}

            -- IMPORTANTE: esto es lo que hace que Explorer muestre dotfiles al abrir
            opts.picker.sources.explorer = vim.tbl_deep_extend("force", opts.picker.sources.explorer or {}, {
                hidden = true, -- muestra .env, .git, etc.
                ignored = true, -- por si .env está gitignored
            })

            return opts
        end,
    },
}
