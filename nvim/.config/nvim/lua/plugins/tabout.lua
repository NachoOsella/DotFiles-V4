return {
    "abecodes/tabout.nvim",
    event = "InsertEnter",
    dependencies = {
        "nvim-treesitter/nvim-treesitter",
    },
    config = function()
        require("tabout").setup {
            -- Changed from <M-Tab> because Hyprland uses ALT+Tab for window cycling (hypr/hypr/binds.lua)
            tabkey = "<M-o>",
            backwards_tabkey = "<M-S-o>",
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
