return {
    {
        "sainnhe/gruvbox-material",
        lazy = false,
        priority = 1000,
        init = function()
            -- Must be set before loading the colorscheme.
            vim.g.gruvbox_material_background = "hard"
            vim.g.gruvbox_material_enable_italic = 1
            vim.g.gruvbox_material_better_performance = 1
        end,
        config = function()
            vim.o.background = "dark"
            vim.cmd.colorscheme("gruvbox-material")
        end,
    },
    {
        "LazyVim/LazyVim",
        opts = {
            colorscheme = "gruvbox-material",
        },
    },
}
