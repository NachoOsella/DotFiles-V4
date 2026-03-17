return {
    "nvim-treesitter/nvim-treesitter",
    opts = {
        highlight = { enable = true },
        indent = { enable = true },
        ensure_installed = {
            "bash",
            "c",
            "dockerfile",
            "html",
            "java",
            "javascript",
            "json",
            "lua",
            "markdown",
            "python",
            "regex",
            "tsx",
            "typescript",
            "angular",
            "yaml",
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
    },
}
