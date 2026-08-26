return {
    "stevearc/conform.nvim",
    opts = {
        format_on_save = {
            timeout_ms = 500,
            lsp_format = "fallback",
        },
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
            -- Java: delegated to jdtls via LSP which reads lua/config/java-style.xml (Eclipse profile "IntelliJ")
            -- Only jdtls understands this XML; conform has no native Eclipse formatter, so we use lsp_format fallback.
            java = { lsp_format = "fallback" },
        },
    },
}
