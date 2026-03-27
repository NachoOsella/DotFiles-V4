return {
    {
        "nvim-neo-tree/neo-tree.nvim",
        opts = function(_, opts)
            opts = opts or {}
            opts.filesystem = opts.filesystem or {}
            opts.filesystem.group_empty_dirs = true
            opts.filesystem.filtered_items = vim.tbl_deep_extend("force", opts.filesystem.filtered_items or {}, {
                hide_dotfiles = false,
                hide_gitignored = false,
            })

            return opts
        end,
        config = function(_, opts)
            local function set_neotree_highlights()
                local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
                local normal_nc = vim.api.nvim_get_hl(0, { name = "NormalNC", link = false })
                local end_of_buffer = vim.api.nvim_get_hl(0, { name = "EndOfBuffer", link = false })
                local sign_column = vim.api.nvim_get_hl(0, { name = "SignColumn", link = false })

                vim.api.nvim_set_hl(0, "NeoTreeNormal", { fg = normal.fg, bg = normal.bg })
                vim.api.nvim_set_hl(0, "NeoTreeNormalNC", {
                    fg = normal_nc.fg or normal.fg,
                    bg = normal_nc.bg or normal.bg,
                })
                vim.api.nvim_set_hl(0, "NeoTreeEndOfBuffer", {
                    fg = end_of_buffer.fg,
                    bg = normal.bg,
                })
                vim.api.nvim_set_hl(0, "NeoTreeSignColumn", {
                    fg = sign_column.fg or normal.fg,
                    bg = sign_column.bg or normal.bg,
                })
                vim.api.nvim_set_hl(0, "NeoTreeWinSeparator", { link = "WinSeparator" })
            end

            require("neo-tree").setup(opts)
            set_neotree_highlights()

            local group = vim.api.nvim_create_augroup("custom_neotree_highlights", { clear = true })
            vim.api.nvim_create_autocmd("ColorScheme", {
                group = group,
                callback = set_neotree_highlights,
            })
            vim.api.nvim_create_autocmd({ "FileType", "BufEnter" }, {
                group = group,
                pattern = "neo-tree",
                callback = set_neotree_highlights,
            })
        end,
    },
}
