return {
    "stevearc/conform.nvim",
    opts = {
        formatters_by_ft = {
            python = { "ruff_format" },
            typescript = { "prettier" },
            typescriptreact = { "prettier" },
            javascript = { "prettier" },
            javascriptreact = { "prettier" },
            json = { "prettier" },
            yaml = { "prettier" },
            html = { "prettier" },
            htmlangular = { "prettier" },
            css = { "prettier" },
            scss = { "prettier" },
            -- Java: delegated to jdtls via LSP which reads lua/config/java-style.xml (Eclipse profile "IntelliJ")
            -- Only jdtls understands this XML; conform has no native Eclipse formatter, so we use lsp_format fallback.
            java = { lsp_format = "fallback" },
        },
    },
}
