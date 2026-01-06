return {
    "nvim-treesitter/nvim-treesitter",
    opts = {
        highlight = { enable = true },
        indent = { enable = true },
        ensure_installed = {
            "bash",
            "c",
            "html",
            "java",
            "javascript",
            "json",
            "lua",
            "markdown",
            "python",
            "typescript",
            "angular",
            "go",
        },
        incremental_selection = {
            enable = true,
            keymaps = {
                init_selection = "<C-space>",
                node_incremental = "<C-space>",
                node_decremental = "<bs>",
            },
        },
        textobjects = {
            move = {
                enable = true,
                goto_next_start = { ["]f"] = "@function.outer" },
                ...,
            },
        },
    },
}
