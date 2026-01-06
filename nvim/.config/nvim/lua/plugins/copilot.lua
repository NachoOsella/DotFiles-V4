return {
    "zbirenbaum/copilot.lua",
    cmd = "Copilot",
    event = "InsertEnter",
    keys = {
        {
            "<leader>at",
            function()
                if require("copilot.client").is_disabled() then
                    require("copilot.command").enable()
                else
                    require("copilot.command").disable()
                end
            end,
            desc = "Toggle (Copilot)",
        },
    },
    opts = {
        -- I don't find the panel useful.
        panel = { enabled = false },
        suggestion = {
            auto_trigger = true,
            -- Use alt to interact with Copilot.
            keymap = {
                accept = "<M-a>",
                accept_word = "<M-w>",
                accept_line = "<M-l>",
                next = "<M-]>",
                prev = "<M-[>",
                dismiss = "<C-]>",
            },
        },
        filetypes = { markdown = true },
    },
    config = function(_, opts)
        require("copilot").setup(opts)
    end,
}
