return {
    "mason-org/mason.nvim",
    opts = {
        ensure_installed = {
            "stylua",
            "lua-language-server",
            "jdtls",
            "prettier",
            "typescript-language-server",
            "dockerfile-language-server", -- Nombre corregido
            "docker-compose-language-service", -- Nombre corregido (es service, no server)
            "ruff",
            "pyright",
        },
    },
}
