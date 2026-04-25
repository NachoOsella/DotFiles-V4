return {
    "stevearc/conform.nvim",
    opts = {
        formatters_by_ft = {
            python = { "ruff_format" },
            lua = { "stylua" },
            typescript = { "prettierd", "prettier", stop_after_first = true },
            typescriptreact = { "prettierd", "prettier", stop_after_first = true },
            javascript = { "prettierd", "prettier", stop_after_first = true },
            javascriptreact = { "prettierd", "prettier", stop_after_first = true },
            json = { "prettierd", "prettier", stop_after_first = true },
            yaml = { "prettierd", "prettier", stop_after_first = true },
            html = { "prettierd", "prettier", stop_after_first = true },
            css = { "prettierd", "prettier", stop_after_first = true },
        },
    },
}
