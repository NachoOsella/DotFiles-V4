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
            "angular-language-server", -- Angular uses the same TS stack, kept here for treesitter angular
            "eslint-lsp",
            "eslint_d",
            "json-lsp",
            "yaml-language-server",
            "dockerfile-language-server",
            "docker-compose-language-service",
            "ruff",
            "pyright",
            -- go removed: not used in this setup
        },
    },
}
