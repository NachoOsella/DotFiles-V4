return {
    "mason-org/mason.nvim",
    opts = {
        ensure_installed = {
            "stylua",
            "lua-language-server",
            "jdtls",
            "prettier",
            "prettierd",
            "typescript-language-server",
            "eslint-lsp",
            "eslint_d",
            "json-lsp",
            "yaml-language-server",
            "dockerfile-language-server", -- Nombre corregido
            "docker-compose-language-service", -- Nombre corregido (es service, no server)
            "ruff",
            "pyright",
        },
    },
}
