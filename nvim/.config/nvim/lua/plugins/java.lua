-- lua/plugins/init.lua
return {
    "mfussenegger/nvim-jdtls",
    ft = "java",
    config = function()
        -- Autocmd para cargar la config cuando se abra un archivo java
        vim.api.nvim_create_autocmd("FileType", {
            pattern = "java",
            callback = function()
                require("config.jdtls").setup()
            end,
        })
    end,
}
