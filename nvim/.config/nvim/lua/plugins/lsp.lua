return {
    "neovim/nvim-lspconfig",
    opts = {
        servers = {
            jdtls = {},
            angularls = { workspace_required = true },
            cssls = {},
            html = {},
            jsonls = {},
            yamlls = {},
            dockerls = {},
            docker_compose_language_service = {},
            pyright = {},
            ruff = {},
            eslint = {
                settings = {
                    options = {
                        overrideConfig = {
                            -- Conform runs Prettier once after ESLint fixes.
                            rules = { ["prettier/prettier"] = "off" },
                        },
                    },
                },
            },
            vtsls = {
                settings = {
                    typescript = {
                        tsserver = {
                            -- One server handles both syntax and semantic requests.
                            useSyntaxServer = "never",
                        },
                    },
                },
            },
        },
        setup = {
            jdtls = function()
                return true
            end,
            eslint = function()
                LazyVim.format.register(LazyVim.lsp.formatter({
                    name = "eslint: lsp",
                    primary = false,
                    priority = 200,
                    filter = "eslint",
                    format = function(buf)
                        -- The default LSP wrapper also runs Conform's CLI formatters.
                        require("conform").format({
                            bufnr = buf,
                            name = "eslint",
                            formatters = {},
                            lsp_format = "always",
                        })
                    end,
                }))
            end,
        },
    },
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
