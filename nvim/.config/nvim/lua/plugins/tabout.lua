return {
    "abecodes/tabout.nvim",
    lazy = false,
    dependencies = {
        "nvim-treesitter/nvim-treesitter",
        "L3MON4D3/LuaSnip", -- if you use snippets
    },
    config = function()
        require("tabout").setup {
            tabkey = "<Tab>",
            backwards_tabkey = "<S-Tab>",
            act_as_tab = true,
            act_as_shift_tab = false,
            enable_backwards = true,
            completion = true, -- keep true to integrate with cmp
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
