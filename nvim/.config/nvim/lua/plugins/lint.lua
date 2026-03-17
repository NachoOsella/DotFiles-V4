return {
    {
        "mfussenegger/nvim-lint",
        optional = true,
        opts = {
            linters_by_ft = {
                python = { "ruff" },
                javascript = { "eslint_d" },
                typescript = { "eslint_d" },
                javascriptreact = { "eslint_d" },
                typescriptreact = { "eslint_d" },
            },
            linters = {
                eslint_d = {
                    condition = function(ctx)
                        return vim.fs.find({
                            "eslint.config.js",
                            "eslint.config.mjs",
                            "eslint.config.cjs",
                            ".eslintrc",
                            ".eslintrc.js",
                            ".eslintrc.cjs",
                            ".eslintrc.json",
                            ".eslintrc.yaml",
                            ".eslintrc.yml",
                        }, { path = ctx.filename, upward = true })[1] ~= nil
                    end,
                },
            },
        },
        config = function(_, opts)
            local lint = require("lint")
            lint.linters_by_ft = opts.linters_by_ft
            for name, linter in pairs(opts.linters or {}) do
                lint.linters[name] = vim.tbl_deep_extend("force", lint.linters[name] or {}, linter)
            end

            local group = vim.api.nvim_create_augroup("user_lint", { clear = true })
            vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost", "InsertLeave" }, {
                group = group,
                callback = function()
                    lint.try_lint()
                end,
            })
        end,
    },
}
