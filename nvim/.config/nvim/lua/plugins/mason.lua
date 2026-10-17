return {
    "mason-org/mason.nvim",
    opts = {
        ensure_installed = {
            -- LazyVim installs configured LSPs, stylua and shfmt.
            -- jdtls uses a custom setup, so Mason must install it explicitly.
            "jdtls",
            "prettier",
        },
    },
}
