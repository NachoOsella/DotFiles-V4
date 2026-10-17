return {
    {
        "nvim-neo-tree/neo-tree.nvim",
        opts = function(_, opts)
            opts = opts or {}
            opts.popup_border_style = "rounded"
            opts.filesystem = opts.filesystem or {}
            opts.filesystem.group_empty_dirs = true
            opts.filesystem.filtered_items = vim.tbl_deep_extend("force", opts.filesystem.filtered_items or {}, {
                hide_dotfiles = false,
                hide_gitignored = false,
                never_show = { ".git", "node_modules", ".angular", "dist", "coverage", "target", "build" },
            })

            return opts
        end,
    },
}
