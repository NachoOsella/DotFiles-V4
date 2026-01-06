return {
    "stevearc/conform.nvim",
    opts = {
        formatters_by_ft = {
            python = { "ruff_format" },
            lua = { "stylua" },
            typescript = { "prettierd" },
            javascript = { "prettierd" },
            html = { "prettierd" },
            css = { "prettierd" },
        },
    },
}
