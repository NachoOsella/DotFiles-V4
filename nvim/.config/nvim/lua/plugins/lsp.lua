return {
    "neovim/nvim-lspconfig",
    init = function()
        -- Silencia notificaciones de progreso del LSP (ej: jdtls “Building…”, “Register Watchers”, etc.)
        vim.lsp.handlers["$/progress"] = function() end
    end,
    opsts = {
        servers = {
            pyrght = {},
            ruff = {},
        },
    },
}
