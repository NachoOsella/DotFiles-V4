return {
    {
        "folke/snacks.nvim",
        opts = function(_, opts)
            opts = opts or {}

            -- Dashboard (your config)
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

            -- Important: this makes Explorer show dotfiles on open
            opts.picker.sources.explorer = vim.tbl_deep_extend("force", opts.picker.sources.explorer or {}, {
                hidden = true, -- show .env, .git, etc.
                ignored = true, -- include files even if gitignored
            })

            opts.lazygit = opts.lazygit or {}
            opts.lazygit.configure = false -- Disable Snacks lazygit theme generation

            return opts
        end,
    },
}
