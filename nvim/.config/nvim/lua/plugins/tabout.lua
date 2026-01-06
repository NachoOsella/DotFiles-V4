return {
    "abecodes/tabout.nvim",
    lazy = false,
    dependencies = {
        "nvim-treesitter/nvim-treesitter",
        "hrsh7th/nvim-cmp", -- si lo usás
        "L3MON4D3/LuaSnip", -- si usás snippets
    },
    config = function()
        require("tabout").setup {
            tabkey = "<Tab>",
            backwards_tabkey = "<S-Tab>",
            act_as_tab = true,
            act_as_shift_tab = false,
            enable_backwards = true,
            completion = true, -- o true, si querés que colabore con cmp
            ignore_beginning = true,
            tabouts = {
                { open = "'", close = "'" },
                { open = '"', close = '"' },
                { open = "`", close = "`" },
                { open = "(", close = ")" },
                { open = "[", close = "]" },
                { open = "{", close = "}" },
            },
            exclude = {},
        }
    end,
}
