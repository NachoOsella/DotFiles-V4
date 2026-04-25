return {
    "neovim/nvim-lspconfig",
    init = function()
        local default_progress_handler = vim.lsp.handlers["$/progress"]

        vim.lsp.handlers["$/progress"] = function(err, result, ctx, config)
            local client = ctx and ctx.client_id and vim.lsp.get_client_by_id(ctx.client_id)
            if client and client.name == "jdtls" then
                return
            end

            if default_progress_handler then
                return default_progress_handler(err, result, ctx, config)
            end
        end
    end,
}
